//! The voxel grid (voxel-grid.ts) and the voxel's faces (fcc.ts), as the
//! TS side hands them over.

/** Kinds of voxel faces. */
pub const FACE_KINDS: usize = 12;
/** f64 per kind in the geometry table: lattice offset (3), normal (3), corners (4 × 3). */
pub const GEOMETRY: usize = 18;
/** i32 per face in the lattice table: R, U, F (3 each). */
pub const LATTICE: usize = 9;
/** Faces of the view (FACES in view.ts). */
pub const VIEW_FACES: usize = 12;

/**
 * The voxel's faces in a face's lattice coordinates, the same for every
 * face (VOXEL_GEOMETRY in bake.ts): kind k's neighbour offset (a, b, c), its normal and
 * its corners in face coordinates.
 */
pub struct Geometry {
    pub offsets: [[i32; 3]; FACE_KINDS],
    pub normals: [[f64; 3]; FACE_KINDS],
    pub corners: [[f64; 12]; FACE_KINDS],
}

impl Geometry {
    pub fn from_table(table: &[f64]) -> Geometry {
        let mut g = Geometry { offsets: [[0; 3]; FACE_KINDS], normals: [[0.0; 3]; FACE_KINDS], corners: [[0.0; 12]; FACE_KINDS] };
        for k in 0..FACE_KINDS {
            let t = &table[k * GEOMETRY..(k + 1) * GEOMETRY];
            for d in 0..3 {
                g.offsets[k][d] = t[d] as i32;
                g.normals[k][d] = t[3 + d];
            }
            g.corners[k].copy_from_slice(&t[6..18]);
        }
        g
    }
}

/** A face's lattice vectors R, U, F (integer, see Face in view.ts). */
#[derive(Clone, Copy)]
pub struct Lattice {
    pub r: [i32; 3],
    pub u: [i32; 3],
    pub f: [i32; 3],
}

/** Dense sites of a box, z-major, then y, then every other x (see VoxelGrid). */
pub struct Grid {
    pub min: [i32; 3],
    pub n: [i32; 3],
    pub cells: Vec<u8>,
}

/** The grid read in a face's lattice coordinates (a, b, c) (see Face in view.ts). */
pub struct Reader<'a> {
    grid: &'a Grid,
    lattice: Lattice,
    /** Bounds of a, b, c over the grid's sites, inclusive. */
    pub min: [i32; 3],
    pub max: [i32; 3],
}

impl<'a> Reader<'a> {
    pub fn new(grid: &'a Grid, lattice: Lattice) -> Reader<'a> {
        let mut min = [i32::MAX; 3];
        let mut max = [i32::MIN; 3];
        for x in [grid.min[0], grid.min[0] + grid.n[0] - 1] {
            for y in [grid.min[1], grid.min[1] + grid.n[1] - 1] {
                for z in [grid.min[2], grid.min[2] + grid.n[2] - 1] {
                    for (d, v) in [lattice.r, lattice.u, lattice.f].iter().enumerate() {
                        let along = x * v[0] + y * v[1] + z * v[2];
                        min[d] = min[d].min(along);
                        max[d] = max[d].max(along);
                    }
                }
            }
        }
        Reader { grid, lattice, min, max }
    }

    /** Material id at (a, b, c); 0 if empty, outside or not a site. */
    #[inline]
    pub fn at(&self, a: i32, b: i32, c: i32) -> u8 {
        if ((a ^ c) | (b ^ c)) & 1 != 0 {
            return 0;
        }
        let Lattice { r, u, f } = self.lattice;
        let g = self.grid;
        let x = (a * r[0] + c * f[0]) / 2 + b * u[0] - g.min[0];
        let y = (a * r[1] + c * f[1]) / 2 + b * u[1] - g.min[1];
        let z = (a * r[2] + c * f[2]) / 2 + b * u[2] - g.min[2];
        if x < 0 || x >= g.n[0] || y < 0 || y >= g.n[1] || z < 0 || z >= g.n[2] {
            return 0;
        }
        g.cells[((z * g.n[1] + y) * (g.n[0] / 2) + (x >> 1)) as usize]
    }
}
