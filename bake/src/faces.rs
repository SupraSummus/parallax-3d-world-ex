//! The faces of a chunk, baked onto its slice's centre plane.

use crate::slicing::{LAYER, bake, chunk_cell, direction_error, direction_step, slice_centre, thickness};
use crate::surface::{MAX_REACH, Slice, Voxel};
use crate::world::{FACE_KINDS, Geometry};

/** A voxel face baked onto a slice's centre plane. */
pub struct Face {
    /** x0, y0, …, x3, y3, in order around it. */
    pub corners: [f64; 8],
    /** An index into the palette: material · FACE_KINDS + kind. */
    pub colour: usize,
    /** Whether a ray along the baking direction reaches it (not only other rays through the chunk). */
    pub reached: bool,
    /** How far past each side of its bounding box (left, bottom, right, top) it is grown to fill gaps (see fill_faces). */
    pub growth: [f64; 4],
    /** Its voxel's lattice coordinates. */
    pub site: [i32; 3],
}

/** The faces of one chunk, in painting order, and the extent of their grown outlines. */
pub struct Faces {
    pub list: Vec<Face>,
    pub min_x: f64,
    pub max_x: f64,
    pub min_y: f64,
    pub max_y: f64,
}

impl Faces {
    pub fn new() -> Faces {
        Faces { list: Vec::new(), min_x: f64::INFINITY, max_x: f64::NEG_INFINITY, min_y: f64::INFINITY, max_y: f64::NEG_INFINITY }
    }

    /** Empties it, keeping the list's memory. */
    fn clear(&mut self) {
        self.list.clear();
        (self.min_x, self.max_x, self.min_y, self.max_y) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
    }

    fn push(&mut self, face: Face) {
        let [gl, gb, gr, gt] = face.growth;
        for c in 0..4 {
            self.min_x = self.min_x.min(face.corners[2 * c] - gl);
            self.max_x = self.max_x.max(face.corners[2 * c] + gr);
            self.min_y = self.min_y.min(face.corners[2 * c + 1] - gb);
            self.max_y = self.max_y.max(face.corners[2 * c + 1] + gt);
        }
        self.list.push(face);
    }
}

/**
 * Fills `faces` with the faces of chunk (i0, j0) of a slice that a ray
 * along (tan_x, tan_y, 1) can reach,
 * baked onto the slice's centre plane, in painting order: far to near. A
 * face is reached if it faces against the ray (normal · direction < 0).
 * The direction must be one of the face's rays (inFace in view.ts).
 *
 * Painting order: layers far to near. Along such a ray, each voxel it
 * passes is followed by one across a face whose normal n has
 * n · (tan_x, tan_y, 1) > 0: one or two layers on, or a neighbour in the
 * same layer, (±2, 0, 0) away. The face to that neighbour is parallel to
 * the axis and as deep as the voxel, so a ray crosses at most one such
 * face per layer: it enters the neighbour through a face that is not
 * drawn. So voxels of one layer never cover each other, and a voxel's
 * faces facing the ray never overlap either.
 *
 * Given the slice `detail` (0 for none), faces are also grown to close the
 * gaps that open between slices (docs/architecture.md, section 3): the
 * open faces of voxels with a neighbour in the next or previous slice,
 * including ones only rays up to direction_error (at most MAX_REACH) off
 * the baking direction reach (marked as not reached).
 *
 * `surface` is the cell's (cell_surface), with the margin around
 * the cell that its chunks may show.
 */
#[allow(clippy::too_many_arguments)]
pub fn chunk_faces(
    faces: &mut Faces,
    geometry: &Geometry,
    surface: &[Voxel],
    slice: &Slice,
    i0: i32,
    j0: i32,
    tan_x: f64,
    tan_y: f64,
    detail: f64,
) {
    faces.clear();
    let cell = chunk_cell(slice.level, i0, j0);
    let centre = slice_centre(slice.level, slice.layer);
    let reach = if detail > 0.0 { MAX_REACH.min(direction_error(detail)) } else { 0.0 };
    let (left, bottom) = (cell.left as f64 * LAYER, cell.bottom as f64);

    // The slice's centre plane is at least (thickness − 1) · detail layer spacings from the camera.
    let per_unit = if detail > 0.0 { 1.0 / ((thickness(slice.level) - 1) as f64 * detail * LAYER) } else { 0.0 };
    let half_step = if detail > 0.0 { direction_step(detail) / 2.0 } else { 0.0 };
    // A ray through the plane at p, from a camera at distance D ≥ that, has
    // tangent σ = τc + (p − cell centre) / D, and the cell's centre ray τc is
    // within half a direction step of the baking direction. A face at depth
    // z′ is drawn (σ − tan) · (z′ − centre) off. Where its voxel meets one in
    // another slice, d = z′ − centre ahead of the plane, that pulls it away
    // from the other slice's drawing of the surface when σ is farther from
    // the screen centre than tan, so the face grows back by that much, for
    // the largest such σ − tan over a face spanning [lo, hi] along an axis,
    // and each d in `ds`. Returns the growth below and above.
    let grow = |tan: f64, cell_centre: f64, lo: f64, hi: f64, ds: &[f64]| -> (f64, f64) {
        let above = ((hi - cell_centre) * per_unit).max(0.0) + half_step;
        let below = ((cell_centre - lo) * per_unit).max(0.0) + half_step;
        // σ above tan opens a gap where σ > 0; below tan, where σ < 0.
        let up = if above > (-tan).max(0.0) { above } else { 0.0 };
        let down = if below > tan.max(0.0) { below } else { 0.0 };
        // σ − tan > 0 moves a point d ahead of the plane towards −(σ − tan) · d.
        ds.iter().fold(
            (0.0, 0.0),
            |(gb, ga): (f64, f64), &d| {
                if d > 0.0 { (gb.max(up * d), ga.max(down * d)) } else { (gb.max(down * -d), ga.max(up * -d)) }
            },
        )
    };
    let cell_x = left + cell.width / 2.0;
    let cell_y = bottom + cell.height / 2.0;

    for voxel in surface {
        let [a, b, c] = voxel.site;
        // Baking moves the layer's sites by (near_x, near_y), and each unit of depth from them by (−tan_x, −tan_y).
        let (near_x, near_y) = bake(0.0, 0.0, c as f64 * LAYER, tan_x, tan_y, centre);
        let (x, y) = (a as f64 * LAYER, b as f64);
        // Only a voxel that goes on into another slice can open a gap, where
        // it meets its neighbour there: within a layer of its own.
        let crossing = per_unit > 0.0 && voxel.cut != 0;
        let ds = [(c - 1) as f64 * LAYER - centre, (c + 1) as f64 * LAYER - centre];
        for k in 0..FACE_KINDS {
            if (voxel.open | voxel.cut) & (1 << k) == 0 {
                continue;
            }
            let [na, nb, nc] = geometry.normals[k];
            let facing = na * tan_x + nb * tan_y + nc;
            let reached = facing < 0.0;
            // Open faces of a crossing voxel grow, also where only rays a little off the direction reach them.
            let grows = crossing && voxel.open & (1 << k) != 0;
            if !reached && !(grows && facing - (na.abs() + nb.abs()) * reach < 0.0) {
                continue;
            }
            let mut corners = [0.0; 8];
            for (i, corner) in geometry.corners[k].chunks(3).enumerate() {
                corners[2 * i] = x + near_x + corner[0] - tan_x * corner[2];
                corners[2 * i + 1] = y + near_y + corner[1] - tan_y * corner[2];
            }
            let mut growth = [0.0; 4];
            if grows {
                let extent = |v: [f64; 4]| (v[0].min(v[1]).min(v[2]).min(v[3]), v[0].max(v[1]).max(v[2]).max(v[3]));
                let (l, r) = extent([corners[0], corners[2], corners[4], corners[6]]);
                let (bt, tp) = extent([corners[1], corners[3], corners[5], corners[7]]);
                let (gl, gr) = grow(tan_x, cell_x, l, r, &ds);
                let (gb, gt) = grow(tan_y, cell_y, bt, tp, &ds);
                growth = [gl, gb, gr, gt];
            }
            let colour = voxel.material as usize * FACE_KINDS + k;
            faces.push(Face { corners, colour, reached, growth, site: voxel.site });
        }
    }
}
