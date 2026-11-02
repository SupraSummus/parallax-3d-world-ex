//! The parts of slice-selection.ts that baking needs, in the same units.

/** Spacing of a face's layers: see LAYER in view.ts. */
pub const LAYER: f64 = std::f64::consts::FRAC_1_SQRT_2;

const CHUNK_WIDTH_PER_SIZE: i32 = 16;

/** N = 2^level: see spacing in cells.ts. */
pub fn spacing(level: i32) -> i32 {
    1 << level
}

/** Layers c − c0 of the sites a cell of `level` holds, around its own layer c0: see ownedLayers in cells.ts. */
pub fn owned_layers(level: i32) -> (i32, i32) {
    let n = spacing(level);
    match level {
        0 => (0, 0),
        1 => (-2, 0),
        _ => (-n, n - 1),
    }
}

/** See ATOM_SHIFT in slice-selection.ts. */
const ATOM_SHIFT: i32 = 3;

/** See atomLevel. */
pub fn atom_level(level: i32) -> i32 {
    (level - ATOM_SHIFT).max(0)
}

/** See siteLayers: the layers a slice's sites may be in, relative to its slab's first. */
pub fn site_layers(level: i32) -> (i32, i32) {
    let atoms = atom_level(level);
    let (lo, hi) = owned_layers(atoms);
    (lo, (1 << level) - spacing(atoms) + hi)
}

/** See thickness in slice-selection.ts. */
pub fn thickness(level: i32) -> i32 {
    let (first, last) = site_layers(level);
    last - first + 2
}

/**
 * A chunk cell of a slice: in lattice units its sites' a and b reach
 * `columns` and `rows`, from (left, bottom); width and height in face
 * units. See chunkCell.
 */
pub struct Cell {
    pub left: i32,
    pub bottom: i32,
    pub columns: i32,
    pub rows: i32,
    pub width: f64,
    pub height: f64,
}

/** Chunk (i, j) of a slice of `level`: brick i of row j. See chunkCell. */
pub fn chunk_cell(level: i32, i: i32, j: i32) -> Cell {
    let m = CHUNK_WIDTH_PER_SIZE / 2 * (1 << level);
    Cell {
        left: (2 * i + (j & 1) - 1) * m,
        bottom: j * m - m / 2,
        columns: 2 * m,
        rows: m,
        width: (2 * m) as f64 * LAYER,
        height: m as f64,
    }
}

/** See sliceCentre: halfway through what the slice's voxels span. */
pub fn slice_centre(level: i32, layer: i32) -> f64 {
    let (first, _) = site_layers(level);
    ((layer * (1 << level) + first - 1) as f64 + thickness(level) as f64 / 2.0) * LAYER
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
