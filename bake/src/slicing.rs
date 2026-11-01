//! The parts of slice-selection.ts that baking needs, in the same units.

/** Spacing of a face's layers: see LAYER in view.ts. */
pub const LAYER: f64 = std::f64::consts::FRAC_1_SQRT_2;

const CHUNK_WIDTH_PER_SIZE: i32 = 16;

/** A chunk cell of a slice of `size`: columns and rows of sites, width and height in face units. See chunkCell. */
pub struct Cell {
    pub columns: i32,
    pub rows: i32,
    pub width: f64,
    pub height: f64,
}

pub fn chunk_cell(size: i32) -> Cell {
    let columns = CHUNK_WIDTH_PER_SIZE * size;
    let rows = CHUNK_WIDTH_PER_SIZE / 2 * size;
    Cell { columns, rows, width: columns as f64 * LAYER, height: rows as f64 }
}

/** See sliceCentre. */
pub fn slice_centre(depth: i32, size: i32) -> f64 {
    (depth as f64 + (size as f64 - 1.0) / 2.0) * LAYER
}

/** See directionStep. */
pub fn direction_step(detail: f64) -> f64 {
    (CHUNK_WIDTH_PER_SIZE as f64 / detail).log2().floor().exp2()
}

/**
 * How far (as a tangent) a ray through a chunk may be from the direction
 * the chunk is baked along: half a chunk's span, C / (2·detail), plus half
 * the direction step. At most C / detail (see bakeAngleError in
 * slice-selection.ts).
 */
pub fn direction_error(detail: f64) -> f64 {
    CHUNK_WIDTH_PER_SIZE as f64 / (2.0 * detail) + direction_step(detail) / 2.0
}

/** Where baking along (tan_x, tan_y, 1) puts point (x, y, z): its parallel projection onto the plane z = centre. */
pub fn bake(x: f64, y: f64, z: f64, tan_x: f64, tan_y: f64, centre: f64) -> (f64, f64) {
    (x - tan_x * (z - centre), y - tan_y * (z - centre))
}
