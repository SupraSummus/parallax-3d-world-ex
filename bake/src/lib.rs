//! Chunk baking, compiled to WebAssembly for the bake workers: the voxel
//! faces of a chunk cell, baked along a direction onto its slice's centre
//! plane and filled into pixels. chunk-baker.ts drives it through the
//! exports at the bottom. See docs/architecture.md, section 3.
//! The same module finds what nearer layers cover on the main thread
//! (coverage.rs).

mod cells;
mod coverage;
mod faces;
mod fill;
mod slicing;
mod surface;
mod world;

use std::cell::RefCell;
use std::collections::HashMap;

use cells::Cells;
use faces::{Faces, chunk_faces};
use fill::{Scratch, fill_faces, solid_blocks};
use slicing::{LAYER, atom_level, chunk_cell, thickness};
use surface::{Slice, Voxel, cell_surface};
use world::{FACE_KINDS, GEOMETRY, Geometry, Grid, LATTICE, Lattice, Reader, VIEW_FACES};

/**
 * Pixels per unit used when rasterising the nearest slices: 20 pixels
 * across a voxel, 2 units wide, so that rhombi magnified near the camera
 * keep their slanted edges. Chunks are rasterised camera-independently so
 * they can be cached and reused as the camera moves; perspective scaling
 * is applied when compositing.
 */
const RENDER_SCALE: f64 = 10.0;

/**
 * Chunk pixels per unit for a slice of `level`: 40 / t, t its thickness
 * (see thickness), between 1 (2 pixels across a voxel) and RENDER_SCALE.
 * Such a slice lies at distance ≥ t · detail · LAYER, where a unit is at
 * most focal / (t · detail · LAYER) screen pixels, about 40 / t with the
 * defaults; finer chunks would not show. Other settings just scale the
 * chunks on screen.
 */
fn render_scale(level: i32) -> f64 {
    (40.0 / thickness(level) as f64).floor().clamp(1.0, RENDER_SCALE)
}

/** Levels of cells slices are made of (atomLevel of MAX_LEVEL in slice-selection.ts), and one more for a cutoff. */
const LEVELS: usize = 5;

/** Cell surfaces kept for baking the same cell along other directions. */
const MAX_SURFACES: usize = 1024;

/** A baked chunk: see ChunkImage. Pixels and blocks stay in the baker until the next bake. */
pub struct Image {
    pub width: usize,
    pub height: usize,
    pub origin_x: f64,
    pub origin_y: f64,
    pub scale: f64,
    pub faces_drawn: usize,
}

/** Face, level, layer, cutoff (as bits), i, j. */
type SurfaceKey = (usize, i32, i32, u64, i32, i32);

/** One world's grid, palettes and lattices, and the buffers reused across bakes. */
pub struct Baker {
    grid: Grid,
    geometry: Geometry,
    lattices: [Lattice; VIEW_FACES],
    /** Per view face: material · FACE_KINDS + kind → RGBA. */
    palettes: Vec<u32>,
    /** Per level, which cell owns each site; made on first use. */
    cells: [Option<Cells>; LEVELS],
    /** Cell surfaces, with the bake count they were last used at. */
    surfaces: HashMap<SurfaceKey, (Vec<Voxel>, u64)>,
    uses: u64,
    faces: Faces,
    scratch: Scratch,
    pub pixels: Vec<u32>,
    pub blocks: Vec<u8>,
    /** The faces as numbers, for faces(). */
    numbers: Vec<f64>,
}

impl Baker {
    pub fn new(grid: Grid, geometry: Geometry, lattices: [Lattice; VIEW_FACES], palettes: Vec<u32>) -> Baker {
        Baker {
            grid,
            geometry,
            lattices,
            palettes,
            cells: Default::default(),
            surfaces: HashMap::new(),
            uses: 0,
            faces: Faces::new(),
            scratch: Scratch::default(),
            pixels: Vec::new(),
            blocks: Vec::new(),
            numbers: Vec::new(),
        }
    }

    /** Fills self.faces with the faces of a chunk (see chunk_faces), from its cell's surface, cached. */
    #[allow(clippy::too_many_arguments)]
    fn chunk_faces(&mut self, face: usize, slice: &Slice, i: i32, j: i32, tan_x: f64, tan_y: f64, detail: f64) {
        self.uses += 1;
        let key = (face, slice.level, slice.layer, slice.cutoff.to_bits(), i, j);
        if !self.surfaces.contains_key(&key) {
            if self.surfaces.len() >= MAX_SURFACES {
                let oldest = self.surfaces.iter().min_by_key(|(_, (_, used))| *used).map(|(k, _)| *k);
                if let Some(oldest) = oldest {
                    self.surfaces.remove(&oldest);
                }
            }
            // The slice's atoms, and the cells one size up only for a cutoff.
            let level = atom_level(slice.level) as usize;
            let above = if slice.cutoff.is_finite() { level + 1 } else { level };
            for l in [level, above] {
                self.cells[l].get_or_insert_with(|| Cells::new(1 << l));
            }
            let (Some(cells), Some(next)) = (&self.cells[level], &self.cells[above]) else { unreachable!() };
            let reader = Reader::new(&self.grid, self.lattices[face]);
            self.surfaces.insert(key, (cell_surface(&reader, &self.geometry, cells, next, slice, i, j), 0));
        }
        let surface = self.surfaces.get_mut(&key).expect("just inserted");
        surface.1 = self.uses;
        chunk_faces(&mut self.faces, &self.geometry, &surface.0, slice, i, j, tan_x, tan_y, detail);
    }

    /**
     * Bakes chunk (i, j) of a slice of view face `face`, along
     * (tan_x, tan_y, 1), grown for slices of `detail` (0 for none), clipped
     * to the cell and cropped to what is drawn. See ChunkBaker.bake.
     */
    #[allow(clippy::too_many_arguments)]
    pub fn bake(&mut self, face: usize, slice: &Slice, i: i32, j: i32, tan_x: f64, tan_y: f64, detail: f64) -> Image {
        self.chunk_faces(face, slice, i, j, tan_x, tan_y, detail);

        // Drawn extent, clipped to the cell.
        let cell = chunk_cell(slice.level, i, j);
        let (left, bottom) = (cell.left as f64 * LAYER, cell.bottom as f64);
        let min_x = self.faces.min_x.max(left);
        let max_x = self.faces.max_x.min(left + cell.width);
        let min_y = self.faces.min_y.max(bottom);
        let max_y = self.faces.max_y.min(bottom + cell.height);

        let scale = render_scale(slice.level);
        let empty = max_x <= min_x || max_y <= min_y;
        let width = if empty { 0 } else { ((max_x - min_x) * scale).ceil() as usize };
        let height = if empty { 0 } else { ((max_y - min_y) * scale).ceil() as usize };
        self.pixels.clear();
        self.pixels.resize(width * height, 0);
        let palettes = self.palettes.len() / VIEW_FACES;
        let palette = &self.palettes[face * palettes..(face + 1) * palettes];
        let faces_drawn = fill_faces(&mut self.scratch, &self.faces, palette, &mut self.pixels, width, height, min_x, max_y, scale);
        solid_blocks(&mut self.blocks, &self.pixels, width, height);
        Image { width, height, origin_x: min_x, origin_y: max_y, scale, faces_drawn }
    }
}

// The WebAssembly interface: chunk-baker.ts fills a world's tables through
// the pointers these return, then bakes chunk after chunk, reading each
// result from RESULT and the pixel and block buffers it points to.

/** A world being handed over, then baking it. */
enum State {
    None,
    Loading { grid: Grid, geometry: Vec<f64>, lattices: Vec<i32>, palettes: Vec<u32> },
    Ready(Box<Baker>),
}

thread_local! {
    static STATE: RefCell<State> = const { RefCell::new(State::None) };
    static RESULT: RefCell<[f64; 9]> = const { RefCell::new([0.0; 9]) };
}

/** Starts a world of `cells` sites and `materials` materials; returns where to write the sites. */
#[unsafe(no_mangle)]
pub extern "C" fn world_cells(cells: usize, materials: usize) -> *mut u8 {
    STATE.with_borrow_mut(|state| {
        *state = State::Loading {
            grid: Grid { min: [0; 3], n: [0; 3], cells: vec![0; cells] },
            geometry: vec![0.0; FACE_KINDS * GEOMETRY],
            lattices: vec![0; VIEW_FACES * LATTICE],
            palettes: vec![0; VIEW_FACES * materials * FACE_KINDS],
        };
        match state {
            State::Loading { grid, .. } => grid.cells.as_mut_ptr(),
            _ => unreachable!(),
        }
    })
}

/** Where to write the loading world's tables: 0 geometry (f64), 1 lattices (i32), 2 palettes (u32). */
#[unsafe(no_mangle)]
pub extern "C" fn world_table(table: u32) -> *mut u8 {
    STATE.with_borrow_mut(|state| match state {
        State::Loading { geometry, lattices, palettes, .. } => match table {
            0 => geometry.as_mut_ptr() as *mut u8,
            1 => lattices.as_mut_ptr() as *mut u8,
            _ => palettes.as_mut_ptr() as *mut u8,
        },
        _ => std::ptr::null_mut(),
    })
}

/** Finishes loading: the grid's box. */
#[unsafe(no_mangle)]
pub extern "C" fn world_ready(min_x: i32, min_y: i32, min_z: i32, nx: i32, ny: i32, nz: i32) {
    STATE.with_borrow_mut(|state| {
        if let State::Loading { mut grid, geometry, lattices, palettes } = std::mem::replace(state, State::None) {
            grid.min = [min_x, min_y, min_z];
            grid.n = [nx, ny, nz];
            let lattices = std::array::from_fn(|f| {
                let l = &lattices[f * LATTICE..(f + 1) * LATTICE];
                Lattice { r: [l[0], l[1], l[2]], u: [l[3], l[4], l[5]], f: [l[6], l[7], l[8]] }
            });
            *state = State::Ready(Box::new(Baker::new(grid, Geometry::from_table(&geometry), lattices, palettes)));
        }
    })
}

/**
 * Bakes a chunk (see Baker::bake); returns RESULT: width, height, origin x,
 * origin y, scale, faces drawn, pixels pointer, blocks pointer, blocks
 * length.
 */
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn bake(face: u32, level: i32, layer: i32, cutoff: f64, i: i32, j: i32, tan_x: f64, tan_y: f64, detail: f64) -> *const f64 {
    STATE.with_borrow_mut(|state| {
        let State::Ready(baker) = state else { return std::ptr::null() };
        let image = baker.bake(face as usize, &Slice { level, layer, cutoff }, i, j, tan_x, tan_y, detail);
        RESULT.with_borrow_mut(|result| {
            *result = [
                image.width as f64,
                image.height as f64,
                image.origin_x,
                image.origin_y,
                image.scale,
                image.faces_drawn as f64,
                baker.pixels.as_ptr() as usize as f64,
                baker.blocks.as_ptr() as usize as f64,
                baker.blocks.len() as f64,
            ];
            result.as_ptr()
        })
    })
}

/**
 * The faces of a chunk before filling, for tests: RESULT holds their count
 * and where they are, 17 f64 each: corners (8), colour, 1 if reached,
 * growth (4) and site (3) (see Face).
 */
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn faces(face: u32, level: i32, layer: i32, cutoff: f64, i: i32, j: i32, tan_x: f64, tan_y: f64, detail: f64) -> *const f64 {
    STATE.with_borrow_mut(|state| {
        let State::Ready(baker) = state else { return std::ptr::null() };
        baker.chunk_faces(face as usize, &Slice { level, layer, cutoff }, i, j, tan_x, tan_y, detail);
        baker.numbers.clear();
        for f in &baker.faces.list {
            baker.numbers.extend(f.corners);
            baker.numbers.extend([f.colour as f64, if f.reached { 1.0 } else { 0.0 }]);
            baker.numbers.extend(f.growth);
            baker.numbers.extend(f.site.map(f64::from));
        }
        RESULT.with_borrow_mut(|result| {
            result[0] = baker.faces.list.len() as f64;
            result[1] = baker.numbers.as_ptr() as usize as f64;
            result.as_ptr()
        })
    })
}
