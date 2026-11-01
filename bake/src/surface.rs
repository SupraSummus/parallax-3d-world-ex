//! The voxels of a chunk cell that can show: its surface, read once per
//! cell and reused for every direction its chunks are baked along.

use crate::slicing::{LAYER, chunk_cell};
use crate::world::{FACE_KINDS, Geometry, Reader};

/** A voxel of a cell's surface. Bit k of `open` and `cut` is face kind k. */
pub struct Voxel {
    /** Lattice coordinates (a, b, c). */
    pub site: [i32; 3],
    pub material: u8,
    /** Faces with no neighbour across them. */
    pub open: u16,
    /** Faces drawn because the slice is cut there: their neighbour is in the previous slice. */
    pub cut: u16,
    /** Whether a neighbour is in the next slice. */
    pub on_far: bool,
}

/** The largest growth chunk_faces looks for, as a tangent (direction_error is about 0.5 with the defaults). */
pub const MAX_REACH: f64 = 1.0;

/**
 * How far around its cell, in face units, a chunk of a slice of `size`
 * may draw voxels: rays through it reach |tan| ≤ 1 in x and LAYER in y,
 * and gap filling MAX_REACH more, over half the slice's thickness, plus
 * the extent of a voxel.
 */
fn cell_margin(size: i32) -> (f64, f64) {
    let half = (size as f64 + 1.0) / 2.0 * LAYER;
    ((1.0 + MAX_REACH) * half + 1.5, (LAYER + MAX_REACH) * half + 1.5)
}

/**
 * The voxels of chunk cell (i, j) (chunkCell in slice-selection.ts) of the
 * slice [depth, depth + size) of a face's layers, and of the margin around
 * it its chunks may show (cell_margin), that have an open face (one no
 * neighbour covers), or a face towards the camera whose neighbour is in
 * the previous slice (the slice is cut there and the cut must show).
 * Buried voxels are dropped. Voxels with a neighbour in the next slice are
 * marked (see chunk_faces). They go by layer, far to near.
 */
pub fn cell_surface(reader: &Reader, geometry: &Geometry, depth: i32, size: i32, i: i32, j: i32) -> Vec<Voxel> {
    let cell = chunk_cell(size);
    let (mx, my) = cell_margin(size);
    let (ma, mb) = ((mx / LAYER).ceil() as i32, my.ceil() as i32);
    let (min, max) = (reader.min, reader.max);
    let a0 = (i * cell.columns - ma).max(min[0]);
    let a1 = ((i + 1) * cell.columns + ma).min(max[0] + 1);
    let b0 = (j * cell.rows - mb).max(min[1]);
    let b1 = ((j + 1) * cell.rows + mb).min(max[1] + 1);
    let top = (depth + size).min(max[2] + 1) - 1;
    let bottom = depth.max(min[2]);
    let mut voxels = Vec::new();
    if a0 >= a1 || b0 >= b1 || top < bottom {
        return voxels;
    }

    // Layers as dense planes of the cell and its sites' neighbours (up to 2
    // away in a, 1 in b): site (a, b) at (b - b0 + 1) · stride + a - a0 + 2.
    let stride = a1 - a0 + 4;
    let plane_size = (stride * (b1 - b0 + 2)) as usize;
    let offsets: [isize; FACE_KINDS] = std::array::from_fn(|k| (geometry.offsets[k][1] * stride + geometry.offsets[k][0]) as isize);
    let fill = |plane: &mut Vec<u8>, c: i32| {
        plane.fill(0);
        // A layer's sites have a and b of the parity of c.
        for b in (b0 - 1 + ((b0 - 1 + c) & 1)..=b1).step_by(2) {
            let row = (b - b0 + 1) * stride - a0 + 2;
            for a in (a0 - 2 + ((a0 + c) & 1)..a1 + 2).step_by(2) {
                plane[(row + a) as usize] = reader.at(a, b, c);
            }
        }
    };

    // Planes of layers c - 2 to c + 2: a voxel's neighbours.
    let mut planes: [Vec<u8>; 5] = std::array::from_fn(|_| vec![0; plane_size]);
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
                let material = current[n as usize];
                if material == 0 {
                    continue;
                }
                let mut open = 0;
                let mut cut = 0;
                let mut on_far = false;
                for k in 0..FACE_KINDS {
                    let dc = geometry.offsets[k][2];
                    if planes[(dc + 2) as usize][(n + offsets[k]) as usize] == 0 {
                        open |= 1 << k;
                    } else if c + dc < depth {
                        cut |= 1 << k;
                    } else if c + dc >= depth + size {
                        on_far = true;
                    }
                }
                if open == 0 && cut == 0 {
                    continue;
                }
                voxels.push(Voxel { site: [a, b, c], material, open, cut, on_far });
            }
        }
    }
    voxels
}
