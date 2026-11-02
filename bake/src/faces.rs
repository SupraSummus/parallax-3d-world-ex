//! The faces of a chunk, baked onto its slice's centre plane.

use crate::slicing::{LAYER, eye_error, slice_centre, spacing};
use crate::surface::{Slice, Voxel};
use crate::world::{FACE_KINDS, Geometry};

/** A voxel face baked onto a slice's centre plane. */
pub struct Face {
    /** x0, y0, …, x3, y3, in order around it. */
    pub corners: [f64; 8],
    /** An index into the palette: material · FACE_KINDS + kind. */
    pub colour: usize,
    /** Whether a ray from the eye reaches it (not only some camera's in the eye's cell). */
    pub reached: bool,
    /** How far past each side of its bounding box (left, bottom, right, top) it is grown to fill gaps (see fill_faces). */
    pub growth: [f64; 4],
    /** Its voxel's lattice coordinates. */
    pub site: [i32; 3],
}

/** The faces of one chunk, in painting order, and the extent of their grown outlines. */
pub struct Faces {
    pub list: Vec<Face>,
    /** Painting order: each surface voxel's squared distance from the eye, and its index. */
    order: Vec<(i64, usize)>,
    pub min_x: f64,
    pub max_x: f64,
    pub min_y: f64,
    pub max_y: f64,
}

impl Faces {
    pub fn new() -> Faces {
        Faces {
            list: Vec::new(),
            order: Vec::new(),
            min_x: f64::INFINITY,
            max_x: f64::NEG_INFINITY,
            min_y: f64::INFINITY,
            max_y: f64::NEG_INFINITY,
        }
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
 * Fills `faces` with the faces of a chunk of a slice that rays from
 * the eye (a site, in lattice coordinates, at least 2N layers before every
 * voxel, N = 2^level) reach, projected from it onto the slice's centre
 * plane, in painting order: far to near. A face is reached if it faces the
 * eye (n · (p − eye) < 0 for its points p).
 *
 * Painting order: voxels by their site's distance from the eye, farthest
 * first. Voxels are the cells of their sites' Voronoi diagram, so a ray
 * from the eye that passes from one voxel into another crosses where
 * their sites are equally far, from the nearer site's side: along every
 * ray, a voxel it meets first is nearer the eye. A voxel's faces facing
 * the eye never overlap.
 *
 * If `fill`, faces are also grown to close the gaps that open between
 * slices (docs/architecture.md, section 3): the open faces of voxels with
 * a neighbour in the next or previous slice, including ones only some
 * camera in the eye's cell faces (marked as not reached).
 *
 * `surface` is the cell's (cell_surface), with the margin around
 * the cell that its chunks may show.
 */
pub fn chunk_faces(faces: &mut Faces, geometry: &Geometry, surface: &[Voxel], slice: &Slice, eye: [i32; 3], fill: bool) {
    faces.clear();
    let centre = slice_centre(slice.level, slice.layer);
    let n = spacing(slice.level) as f64;
    let (ex, ey, ez) = (eye[0] as f64 * LAYER, eye[1] as f64, eye[2] as f64 * LAYER);
    // Projected from the eye onto the centre plane.
    let project = |x: f64, y: f64, z: f64| {
        let t = (centre - ez) / (z - ez);
        (ex + (x - ex) * t, ey + (y - ey) * t)
    };

    let mut order = std::mem::take(&mut faces.order);
    order.clear();
    order.extend(surface.iter().enumerate().map(|(k, voxel)| {
        let [a, b, c] = voxel.site;
        let [da, db, dc] = [(a - eye[0]) as i64, (b - eye[1]) as i64, (c - eye[2]) as i64];
        // Twice the squared distance: a and c are LAYER per unit, b is 1.
        (da * da + 2 * db * db + dc * dc, k)
    }));
    order.sort_unstable_by_key(|&(distance, _)| std::cmp::Reverse(distance));

    for &(_, k) in &order {
        let voxel = &surface[k];
        let [a, b, c] = voxel.site;
        let (x, y, z) = (a as f64 * LAYER, b as f64, c as f64 * LAYER);
        // A camera in the eye's cell sees the voxel's points at most `error`
        // off the eye's rays (as tangents); a point d ahead of the centre
        // plane is drawn (σ − τ) · d off, σ the camera's ray and τ the eye's
        // (section 2). Where its voxel meets one in another slice, that pulls
        // it away from the other slice's drawing of the surface when σ is
        // farther from the screen centre than τ, so the face grows back by
        // that much. Only a voxel that goes on into another slice can open
        // a gap, where it meets its neighbour there: within a layer of its own.
        let crossing = fill && voxel.cut != 0;
        let error = eye_error(slice.level, (c - 1 - eye[2]) as f64);
        let ds = [(c - 1) as f64 * LAYER - centre, (c + 1) as f64 * LAYER - centre];
        // Growth below and above along an axis where the eye's ray has tangent τ.
        let grow = |tau: f64| {
            // σ > τ opens a gap where σ > 0, σ < τ where σ < 0.
            let up = if tau + error > 0.0 { error } else { 0.0 };
            let down = if tau - error < 0.0 { error } else { 0.0 };
            // σ − τ > 0 moves a point d ahead of the plane towards −(σ − τ) · d.
            ds.iter().fold(
                (0.0, 0.0),
                |(gb, ga): (f64, f64), &d| {
                    if d > 0.0 { (gb.max(up * d), ga.max(down * d)) } else { (gb.max(down * -d), ga.max(up * -d)) }
                },
            )
        };
        for kind in 0..FACE_KINDS {
            if (voxel.open | voxel.cut) & (1 << kind) == 0 {
                continue;
            }
            let [na, nb, nc] = geometry.normals[kind];
            // n · (p − eye) for its points p: n · (p − site) = 1 on the face (|n| = √2).
            let facing = na * (x - ex) + nb * (y - ey) + nc * (z - ez) + 1.0;
            let reached = facing < 0.0;
            // Open faces of a crossing voxel grow, also where only some camera
            // in the eye's cell faces them: the cell reaches N / √2 along n, n · δ ≤ N.
            let grows = crossing && voxel.open & (1 << kind) != 0;
            if !reached && !(grows && facing < n) {
                continue;
            }
            let mut corners = [0.0; 8];
            for (i, corner) in geometry.corners[kind].chunks(3).enumerate() {
                (corners[2 * i], corners[2 * i + 1]) = project(x + corner[0], y + corner[1], z + corner[2]);
            }
            let mut growth = [0.0; 4];
            if grows {
                let (gl, gr) = grow((x - ex) / (z - ez));
                let (gb, gt) = grow((y - ey) / (z - ez));
                growth = [gl, gb, gr, gt];
            }
            let colour = voxel.material as usize * FACE_KINDS + kind;
            faces.push(Face { corners, colour, reached, growth, site: voxel.site });
        }
    }
    faces.order = order;
}
