//! The voxels of a chunk cell that can show: its surface, read once per
//! cell and reused for every direction its chunks are baked along.

use crate::cells::Cells;
use crate::slicing::{LAYER, chunk_cell, site_layers, thickness};
use crate::world::{FACE_KINDS, Geometry, Reader};

/** A voxel of a cell's surface. Bit k of `open` and `cut` is face kind k. */
pub struct Voxel {
    /** Lattice coordinates (a, b, c). */
    pub site: [i32; 3],
    pub material: u8,
    /** Faces with no neighbour across them. */
    pub open: u16,
    /**
     * Faces drawn because the slice is cut there: their neighbour is in
     * another slice. Cells of neighbouring layers interlock, so that may be
     * a farther one, even across a face towards the camera.
     */
    pub cut: u16,
}

/**
 * A slice: slab `layer` of `level` (see SliceId in slice-selection.ts),
 * the sites whose atom (cell of atom_level) has its site in the slab's
 * 2^level layers. If `cutoff` is finite, only those whose cell one atom
 * size up lies before layer `cutoff`.
 */
pub struct Slice {
    pub level: i32,
    pub layer: i32,
    pub cutoff: f64,
}

/** The largest growth chunk_faces looks for, as a tangent (direction_error is about 0.5 with the defaults). */
pub const MAX_REACH: f64 = 1.0;

/**
 * How far around its cell, in face units, a chunk of a slice of `level`
 * may draw voxels: rays through it reach |tan| ≤ 1 in x and LAYER in y,
 * and gap filling MAX_REACH more, over half the slice's thickness, plus
 * the extent of a voxel.
 */
fn cell_margin(level: i32) -> (f64, f64) {
    let half = thickness(level) as f64 / 2.0 * LAYER;
    ((1.0 + MAX_REACH) * half + 1.5, (LAYER + MAX_REACH) * half + 1.5)
}

/** Where a site is relative to a slice: in a nearer one, in it, in a farther one. */
const NEARER: i8 = -1;
const IN: i8 = 0;
const FARTHER: i8 = 1;

/**
 * The voxels of chunk cell (i, j) (chunkCell in slice-selection.ts) of
 * a slice, and of the margin around it its chunks may show (cell_margin),
 * that have an open face (one no neighbour covers), or a face whose
 * neighbour is in another slice (the slice is cut there and the cut must
 * show). Buried voxels are dropped. They go by layer, far to near.
 * `cells` are the slice's atoms', `next` those one size up (for the
 * cutoff).
 */
pub fn cell_surface(reader: &Reader, geometry: &Geometry, cells: &Cells, next: &Cells, slice: &Slice, i: i32, j: i32) -> Vec<Voxel> {
    let cell = chunk_cell(slice.level, i, j);
    let (mx, my) = cell_margin(slice.level);
    let (ma, mb) = ((mx / LAYER).ceil() as i32, my.ceil() as i32);
    let (min, max) = (reader.min, reader.max);
    let a0 = (cell.left - ma).max(min[0]);
    let a1 = (cell.left + cell.columns + ma).min(max[0] + 1);
    let b0 = (cell.bottom - mb).max(min[1]);
    let b1 = (cell.bottom + cell.rows + mb).min(max[1] + 1);
    // Its atoms' sites are in layers [start, end).
    let start = slice.layer * (1 << slice.level);
    let end = start + (1 << slice.level);
    let (first, last) = site_layers(slice.level);
    let top = (start + last).min(max[2]);
    let bottom = (start + first).max(min[2]);
    let mut voxels = Vec::new();
    if a0 >= a1 || b0 >= b1 || top < bottom {
        return voxels;
    }

    let classify = |a: i32, b: i32, c: i32| -> i8 {
        if slice.cutoff.is_finite() && next.owner_c(a, b, c) as f64 >= slice.cutoff {
            return FARTHER;
        }
        let owner = cells.owner_c(a, b, c);
        if owner < start {
            NEARER
        } else if owner >= end {
            FARTHER
        } else {
            IN
        }
    };

    // Layers as dense planes of the cell and its sites' neighbours (up to 2
    // away in a, 1 in b): site (a, b) at (b - b0 + 1) · stride + a - a0 + 2,
    // its material and where it is relative to the slice.
    let stride = a1 - a0 + 4;
    let plane_size = (stride * (b1 - b0 + 2)) as usize;
    let offsets: [isize; FACE_KINDS] = std::array::from_fn(|k| (geometry.offsets[k][1] * stride + geometry.offsets[k][0]) as isize);
    let fill = |plane: &mut (Vec<u8>, Vec<i8>), c: i32| {
        plane.0.fill(0);
        // A layer's sites have a and b of the parity of c.
        for b in (b0 - 1 + ((b0 - 1 + c) & 1)..=b1).step_by(2) {
            let row = (b - b0 + 1) * stride - a0 + 2;
            for a in (a0 - 2 + ((a0 + c) & 1)..a1 + 2).step_by(2) {
                let material = reader.at(a, b, c);
                plane.0[(row + a) as usize] = material;
                if material != 0 {
                    plane.1[(row + a) as usize] = classify(a, b, c);
                }
            }
        }
    };

    // Planes of layers c - 2 to c + 2: a voxel's neighbours.
    let mut planes: [(Vec<u8>, Vec<i8>); 5] = std::array::from_fn(|_| (vec![0; plane_size], vec![0; plane_size]));
    for d in -2..=2 {
        fill(&mut planes[(d + 2) as usize], top + d);
    }
    for c in (bottom..=top).rev() {
        if c < top {
            planes.rotate_right(1);
            fill(&mut planes[0], c - 2);
        }
        let current = &planes[2];
        for b in (b0 + ((b0 + c) & 1)..b1).step_by(2) {
            let row = (b - b0 + 1) * stride - a0 + 2;
            for a in (a0 + ((a0 + c) & 1)..a1).step_by(2) {
                let n = (row + a) as isize;
                let material = current.0[n as usize];
                if material == 0 || current.1[n as usize] != IN {
                    continue;
                }
                let mut open = 0;
                let mut cut = 0;
                for k in 0..FACE_KINDS {
                    let (materials, places) = &planes[(geometry.offsets[k][2] + 2) as usize];
                    let m = (n + offsets[k]) as usize;
                    if materials[m] == 0 {
                        open |= 1 << k;
                    } else if places[m] != IN {
                        cut |= 1 << k;
                    }
                }
                if open == 0 && cut == 0 {
                    continue;
                }
                voxels.push(Voxel { site: [a, b, c], material, open, cut });
            }
        }
    }
    voxels
}
