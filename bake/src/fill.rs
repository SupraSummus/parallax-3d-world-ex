//! Baked faces filled into pixels, and which blocks of them are solid.

use crate::faces::Faces;

/** Reused buffers: rasterise's row bounds, the map to the next empty pixel, and which faces covered a pixel. */
#[derive(Default)]
pub struct Scratch {
    bounds: Vec<(f64, f64)>,
    next_empty: Vec<u32>,
    covered: Vec<bool>,
}

/**
 * Calls `span(row, from, to)` with the pixels of each row whose centre is
 * in the convex polygon `points` (n ≤ 8 x, y pairs in pixel coordinates,
 * y down), clipped to width × height. Edges are half-open (an edge from y0
 * to y1 covers [y0, y1) across, [x_left, x_right) along a row), and an edge
 * is evaluated from its upper end whichever polygon it belongs to, so
 * polygons sharing an edge neither overlap nor leave a gap there.
 */
#[inline(always)]
fn rasterise(
    bounds: &mut Vec<(f64, f64)>,
    points: &[f64],
    n: usize,
    width: usize,
    height: usize,
    mut span: impl FnMut(usize, usize, usize),
) {
    let mut min_y = f64::INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for i in 0..n {
        min_y = min_y.min(points[2 * i + 1]);
        max_y = max_y.max(points[2 * i + 1]);
    }
    let first = (min_y - 0.5).ceil().max(0.0);
    let last = (max_y - 0.5).ceil().min(height as f64);
    if first >= last {
        return;
    }
    // Leftmost and rightmost crossing of each row's centre line: an edge
    // from y0 to y1 crosses the rows whose centre is in [y0, y1).
    bounds.clear();
    bounds.resize((last - first) as usize, (f64::INFINITY, f64::NEG_INFINITY));
    for i in 0..n {
        let j = if i + 1 == n { 0 } else { i + 1 };
        let (mut px, mut py, mut qx, mut qy) = (points[2 * i], points[2 * i + 1], points[2 * j], points[2 * j + 1]);
        if py == qy {
            continue;
        }
        if py > qy {
            (px, py, qx, qy) = (qx, qy, px, py);
        }
        let slope = (qx - px) / (qy - py);
        let mut row = (py - 0.5).ceil().max(first);
        let end = (qy - 0.5).ceil().min(last);
        while row < end {
            let x = px + slope * (row + 0.5 - py);
            let bound = &mut bounds[(row - first) as usize];
            bound.0 = bound.0.min(x);
            bound.1 = bound.1.max(x);
            row += 1.0;
        }
    }
    for (k, &(left, right)) in bounds.iter().enumerate() {
        let from = (left - 0.5).ceil().max(0.0);
        let to = (right - 0.5).ceil().min(width as f64);
        if from < to {
            span(first as usize + k, from as usize, to as usize);
        }
    }
}

/**
 * The quadrilateral `quad` swept over the rectangle [-left, right] × [-up, down]
 * (their Minkowski sum), written to the start of `quad`; returns its number
 * of corners (at most 8). Both are convex, so their edges are merged by
 * angle.
 */
fn sweep(quad: &mut [f64; 16], left: f64, up: f64, right: f64, down: f64) -> usize {
    // Counter-clockwise (positive area, with y as given), starting at the lowest corner.
    let area = (quad[2] - quad[0]) * (quad[5] - quad[1]) - (quad[3] - quad[1]) * (quad[4] - quad[0]);
    let at = |i: usize| (if area >= 0.0 { i } else { 8 - i }) % 4;
    let mut start = 0;
    for i in 1..4 {
        if quad[2 * i + 1] < quad[2 * start + 1] || (quad[2 * i + 1] == quad[2 * start + 1] && quad[2 * i] < quad[2 * start]) {
            start = i;
        }
    }
    let start_step = if area >= 0.0 { start } else { (8 - start) % 4 };
    // The rectangle's corners counter-clockwise from the lowest.
    let rx = [-left, right, right, -left];
    let ry = [-up, -up, down, down];
    let mut swept = [0.0; 16];
    let (mut i, mut j, mut n) = (0, 0, 0);
    while i < 4 || j < 4 {
        let p = at(start_step + i);
        swept[2 * n] = quad[2 * p] + rx[j % 4];
        swept[2 * n + 1] = quad[2 * p + 1] + ry[j % 4];
        n += 1;
        let q = at(start_step + i + 1);
        let ex = quad[2 * q] - quad[2 * p];
        let ey = quad[2 * q + 1] - quad[2 * p + 1];
        let fx = rx[(j + 1) % 4] - rx[j % 4];
        let fy = ry[(j + 1) % 4] - ry[j % 4];
        let turn = ex * fy - ey * fx;
        // A side of zero length (no growth that way) is passed alone.
        if j < 4 && fx == 0.0 && fy == 0.0 {
            j += 1;
        } else if (i < 4 && ex == 0.0 && ey == 0.0) || j == 4 || (i < 4 && turn > 0.0) {
            i += 1;
        } else if i == 4 || turn < 0.0 {
            j += 1;
        } else {
            i += 1;
            j += 1;
        }
    }
    quad[..2 * n].copy_from_slice(&swept[..2 * n]);
    n
}

/**
 * Fills baked faces into a width × height pixel buffer showing the centre
 * plane from (origin_x, origin_y) (top-left) at `scale` pixels per unit,
 * without antialiasing: a pixel is filled when its centre is inside, with
 * half-open edges, so faces sharing an edge neither overlap nor leave a gap
 * there. Faces the eye reaches are painted in order.
 *
 * Then every face, grown (its outline swept over the rectangle of its
 * growth, see Face), is painted where nothing is yet, nearest first. This
 * closes the gaps between slices (docs/architecture.md, section 3)
 * without changing what the chunk already shows. Returns how many faces
 * covered a pixel.
 */
#[allow(clippy::too_many_arguments)]
pub fn fill_faces(
    scratch: &mut Scratch,
    faces: &Faces,
    palette: &[u32],
    pixels: &mut [u32],
    width: usize,
    height: usize,
    origin_x: f64,
    origin_y: f64,
    scale: f64,
) -> usize {
    let mut polygon = [0.0f64; 16];
    // A face's corners in pixel coordinates.
    let outline = |polygon: &mut [f64; 16], corners: &[f64; 8]| {
        for c in 0..4 {
            polygon[2 * c] = (corners[2 * c] - origin_x) * scale;
            polygon[2 * c + 1] = (origin_y - corners[2 * c + 1]) * scale;
        }
    };
    let Scratch { bounds, next_empty, covered } = scratch;
    covered.clear();
    covered.resize(faces.list.len(), false);
    for (f, face) in faces.list.iter().enumerate() {
        if !face.reached {
            continue;
        }
        outline(&mut polygon, &face.corners);
        let colour = palette[face.colour];
        rasterise(bounds, &polygon, 4, width, height, |row, from, to| {
            pixels[row * width + from..row * width + to].fill(colour);
            covered[f] = true;
        });
    }
    // next[i] leads to the first empty pixel at or after i (by path halving),
    // so the grown faces skip what is painted.
    let area = width * height;
    next_empty.clear();
    next_empty.extend(pixels.iter().enumerate().map(|(i, &p)| if p == 0 { i as u32 } else { i as u32 + 1 }));
    next_empty.push(area as u32);
    let next = next_empty;
    let empty = |next: &mut Vec<u32>, mut i: usize| {
        while next[i] as usize != i {
            next[i] = next[next[i] as usize];
            i = next[i] as usize;
        }
        i
    };
    for (f, face) in faces.list.iter().enumerate().rev() {
        let [gl, gb, gr, gt] = face.growth.map(|g| g * scale);
        let flat = gl == 0.0 && gb == 0.0 && gr == 0.0 && gt == 0.0;
        // A reached face that is not grown is painted already.
        if flat && face.reached {
            continue;
        }
        outline(&mut polygon, &face.corners);
        // The outline swept over the growth rectangle (pixel y is down, so up is −y).
        let n = if flat { 4 } else { sweep(&mut polygon, gl, gt, gr, gb) };
        let colour = palette[face.colour];
        rasterise(bounds, &polygon, n, width, height, |row, from, to| {
            let to = row * width + to;
            let mut i = empty(next, row * width + from);
            while i < to {
                pixels[i] = colour;
                next[i] = i as u32 + 1;
                covered[f] = true;
                i = empty(next, i + 1);
            }
        });
    }
    covered.iter().filter(|&&c| c).count()
}

/** Side of a block of pixels in solid_blocks. */
pub const BLOCK: usize = 4;
/** A block's bits in solid_blocks: all its pixels drawn, some drawn. */
pub const SOLID: u8 = 1;
pub const DRAWN: u8 = 2;

/**
 * Which BLOCK × BLOCK blocks of an image are all drawn (SOLID) and which
 * have a pixel drawn (DRAWN), a byte of bits per block, in rows, for
 * finding what a chunk hides and whether it is hidden (coverage.rs).
 * A block reaching past the image's edge counts its pixels in the image.
 */
pub fn solid_blocks(blocks: &mut Vec<u8>, pixels: &[u32], width: usize, height: usize) {
    let cols = width.div_ceil(BLOCK);
    let rows = height.div_ceil(BLOCK);
    blocks.clear();
    blocks.resize(cols * rows, SOLID);
    for y in 0..height {
        let row = &pixels[y * width..(y + 1) * width];
        let block_row = &mut blocks[y / BLOCK * cols..(y / BLOCK + 1) * cols];
        for (block, run) in block_row.iter_mut().zip(row.chunks(BLOCK)) {
            let drawn = run.iter().filter(|&&p| p != 0).count();
            if drawn < run.len() {
                *block &= !SOLID;
            }
            if drawn > 0 {
                *block |= DRAWN;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::faces::Face;

    fn face(corners: [f64; 8], colour: usize) -> Face {
        Face { corners, colour, reached: true, growth: [0.0; 4], site: [0; 3] }
    }

    /** The faces filled into 40 × 40 pixels showing [0, 4] × [0, 4] at 10 pixels per unit; the palette maps a colour to itself. */
    fn fill(list: Vec<Face>) -> Vec<u32> {
        let mut faces = Faces::new();
        faces.list = list;
        let palette: Vec<u32> = (0..16).collect();
        let mut pixels = vec![0; 40 * 40];
        fill_faces(&mut Scratch::default(), &faces, &palette, &mut pixels, 40, 40, 0.0, 4.0, 10.0);
        pixels
    }

    /** Seeded uniform samples in [0, 1). */
    fn random(state: &mut u64) -> f64 {
        *state = (*state * 1103515245 + 12345) % 2147483648;
        *state as f64 / 2147483648.0
    }

    #[test]
    fn fills_parallelograms_sharing_an_edge_without_overlap_or_gaps() {
        // A parallelogram cut in two along a slanted line through it.
        let whole = fill(vec![face([0.13, 0.31, 1.7, 0.47, 2.11, 2.93, 0.54, 2.77], 1)]);
        let left = fill(vec![face([0.13, 0.31, 0.9, 0.39, 1.33, 2.85, 0.54, 2.77], 1)]);
        let right = fill(vec![face([0.9, 0.39, 1.7, 0.47, 2.11, 2.93, 1.33, 2.85], 1)]);
        assert!(whole.iter().sum::<u32>() > 300);
        let halves: Vec<u32> = left.iter().zip(&right).map(|(l, r)| l + r).collect();
        assert_eq!(whole, halves);
    }

    #[test]
    fn grows_a_face_into_its_outline_swept_over_the_growth_rectangle() {
        // Pixel centre p is in the swept outline iff the rectangle
        // [p.x − right, p.x + left] × [p.y − top, p.y + bottom] meets the face:
        // no separating axis among the rectangle's and the face's sides.
        let meets = |corners: &[f64; 8], x0: f64, x1: f64, y0: f64, y1: f64| {
            let rect = [x0, y0, x1, y0, x1, y1, x0, y1];
            let sides = (0..2).map(|i| [corners[2 * i + 3] - corners[2 * i + 1], corners[2 * i] - corners[2 * i + 2]]);
            [[1.0, 0.0], [0.0, 1.0]].into_iter().chain(sides).all(|[ax, ay]| {
                let project = |points: &[f64; 8]| {
                    let along: Vec<f64> = points.chunks(2).map(|p| p[0] * ax + p[1] * ay).collect();
                    (along.iter().cloned().fold(f64::INFINITY, f64::min), along.iter().cloned().fold(f64::NEG_INFINITY, f64::max))
                };
                let ((p0, p1), (q0, q1)) = (project(corners), project(&rect));
                p1 >= q0 && q1 >= p0
            })
        };
        let mut state = 7;
        let mut painted = 0;
        for _ in 0..200 {
            let [ox, oy] = [random(&mut state) * 2.0 + 1.0, random(&mut state) * 2.0 + 1.0];
            let [ax, ay, bx, by] = std::array::from_fn(|_| random(&mut state) * 2.0 - 1.0);
            let corners = [ox, oy, ox + ax, oy + ay, ox + ax + bx, oy + ay + by, ox + bx, oy + by];
            // Some sides not grown at all.
            let growth = std::array::from_fn(|_| if random(&mut state) < 0.3 { 0.0 } else { random(&mut state) });
            let pixels = fill(vec![Face { reached: false, growth, ..face(corners, 1) }]);
            let [left, bottom, right, top] = growth;
            for row in 0..40 {
                for col in 0..40 {
                    let (x, y) = ((col as f64 + 0.5) / 10.0, 4.0 - (row as f64 + 0.5) / 10.0);
                    assert_eq!(pixels[row * 40 + col] == 1, meets(&corners, x - right, x + left, y - top, y + bottom));
                    painted += pixels[row * 40 + col];
                }
            }
        }
        assert!(painted > 10_000);
    }

    #[test]
    fn paints_reached_faces_in_order_then_grows_every_face_only_into_empty_pixels() {
        let square = |x: f64, y: f64, s: f64| [x, y, x + s, y, x + s, y + s, x, y + s];
        let pixels = fill(vec![
            // Grown right and up.
            Face { growth: [0.0, 0.0, 1.0, 1.0], ..face(square(0.0, 0.0, 2.0), 0xa) },
            // Painted over 0xa.
            face(square(1.0, 0.0, 2.0), 0xb),
            // Not reached: painted only where empty.
            Face { reached: false, ..face(square(3.0, 3.0, 0.5), 0xc) },
        ]);
        let at = |x: f64, y: f64| pixels[((4.0 - y) * 10.0) as usize * 40 + (x * 10.0) as usize];
        // 0xc is nearer than 0xa's growth, so it is painted first.
        let shown = [at(0.5, 0.5), at(1.5, 0.5), at(2.5, 1.5), at(0.5, 2.5), at(3.2, 3.2), at(3.8, 3.8)];
        assert_eq!(shown, [0xa, 0xb, 0xb, 0xa, 0xc, 0]);
    }

    #[test]
    fn marks_blocks_all_drawn_or_partly_drawn() {
        // 6 × 5 pixels: blocks of 4 × 4, the right and bottom ones cut by the edge.
        let mut pixels = vec![0u32; 6 * 5];
        for y in 0..4 {
            for x in 0..4 {
                pixels[y * 6 + x] = 7;
            }
        }
        // The right block's pixels in the image all drawn, the bottom right one partly.
        for y in 0..4 {
            pixels[y * 6 + 4] = 7;
            pixels[y * 6 + 5] = 7;
        }
        pixels[4 * 6 + 5] = 7;
        let mut blocks = Vec::new();
        solid_blocks(&mut blocks, &pixels, 6, 5);
        assert_eq!(blocks, vec![SOLID | DRAWN, SOLID | DRAWN, 0, DRAWN]);
    }
}
