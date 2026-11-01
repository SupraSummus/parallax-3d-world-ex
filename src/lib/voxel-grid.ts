/**
 * Dense voxel storage on the face-centred cubic (FCC) lattice: one material
 * id per site of a box (0 = empty). Sites are the integer points with
 * x + y + z even; each is the centre of a rhombic dodecahedron (fcc.ts).
 * Plain typed arrays and integer ids, the same layout in TS or Rust/WASM.
 */

import type { Basis } from './view'
import type { Vec3 } from './world'

export interface Voxel {
  x: number
  y: number
  z: number
  color: string
  type: number
}

export interface Material {
  /** '#rrggbb' */
  color: string
  type: number
}

/** A grid's fields without its methods: what a worker receives from postMessage. */
export type VoxelData = Pick<VoxelGrid, 'minX' | 'minY' | 'minZ' | 'nx' | 'ny' | 'nz' | 'cells' | 'materials'>

/** Half-open integer box: x in [minX, maxX), y and z likewise. */
interface Box {
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

/** Material ids are bytes. */
const MAX_MATERIALS = 256

/** Whether (x, y, z) is a site of the lattice. */
export const isSite = (x: number, y: number, z: number) => ((x + y + z) & 1) === 0

/**
 * Sites are laid out z-major, then y, then x. A row (y, z) holds every
 * other x: those with x + y + z even. minX and nx are even, so site
 * (x, y, z) is cells[((z - minZ) · ny + (y - minY)) · nx / 2 + (x - minX) / 2],
 * rounded down.
 */
export class VoxelGrid {
  readonly minX: number
  readonly minY: number
  readonly minZ: number
  readonly nx: number
  readonly ny: number
  readonly nz: number
  /** Material id per site; 0 is empty. */
  readonly cells: Uint8Array
  /** Material of each id; entry 0 (empty) is unused. */
  readonly materials: readonly Material[]

  /** A grid of the sites in `box`, widened by one in x if needed to start and end on an even x. */
  constructor(box: Box, materials: readonly Material[]) {
    if (materials.length > MAX_MATERIALS) throw new RangeError(`at most ${String(MAX_MATERIALS)} materials`)
    this.minX = Math.floor(box.minX / 2) * 2
    this.minY = box.minY
    this.minZ = box.minZ
    this.nx = Math.max(0, Math.ceil(box.maxX / 2) * 2 - this.minX)
    this.ny = Math.max(0, box.maxY - box.minY)
    this.nz = Math.max(0, box.maxZ - box.minZ)
    this.cells = new Uint8Array((this.nx / 2) * this.ny * this.nz)
    this.materials = materials
  }

  /** Index of site (x, y, z) in `cells`, or -1 outside the box or if it is not a site. */
  index(x: number, y: number, z: number): number {
    const i = x - this.minX
    const j = y - this.minY
    const k = z - this.minZ
    if (i < 0 || i >= this.nx || j < 0 || j >= this.ny || k < 0 || k >= this.nz || !isSite(x, y, z)) return -1
    return (k * this.ny + j) * (this.nx / 2) + (i >> 1)
  }

  /** Material id at (x, y, z); 0 if empty, outside the box or not a site. */
  get(x: number, y: number, z: number): number {
    const i = this.index(x, y, z)
    return i < 0 ? 0 : this.cells[i]
  }

  /** Fills the sites in the box [x0, x1) × [y0, y1) × [z0, z1) with material `id` (0 clears), clipped to the grid. */
  fillBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number) {
    const [fromX, toX] = [Math.max(x0, this.minX), Math.min(x1, this.minX + this.nx)]
    for (let z = Math.max(z0, this.minZ); z < Math.min(z1, this.minZ + this.nz); z++) {
      for (let y = Math.max(y0, this.minY); y < Math.min(y1, this.minY + this.ny); y++) {
        const row = ((z - this.minZ) * this.ny + (y - this.minY)) * (this.nx / 2)
        for (let x = fromX + ((fromX + y + z) & 1); x < toX; x += 2) this.cells[row + ((x - this.minX) >> 1)] = id
      }
    }
  }

  /**
   * Number of voxels with p · F in [from, to), for an integer vector F with
   * two components ±1 and one 0 (a face's lattice.forward): the layers of
   * a slice, see view.ts.
   */
  countAlong({ x: fx, y: fy, z: fz }: Vec3, from: number, to: number): number {
    const { minX, minY, minZ, nx, ny, nz, cells } = this
    // [lo, hi) clipped to the v with f · v in [a, b), for f in -1, 0, 1.
    const clip = (f: number, lo: number, hi: number, a: number, b: number) =>
      f > 0 ? [Math.max(lo, a), Math.min(hi, b)] : f < 0 ? [Math.max(lo, 1 - b), Math.min(hi, 1 - a)] : a <= 0 && 0 < b ? [lo, hi] : [lo, lo]
    // The extremes of f · v over the box's x and y.
    const extremes = (f: number, lo: number, n: number) => [Math.min(f * lo, f * (lo + n - 1)), Math.max(f * lo, f * (lo + n - 1))]
    const [x0, x1] = extremes(fx, minX, nx)
    const [y0, y1] = extremes(fy, minY, ny)
    let count = 0
    const [zFrom, zTo] = clip(fz, minZ, minZ + nz, from - y1 - x1, to - y0 - x0)
    for (let z = zFrom; z < zTo; z++) {
      const [yFrom, yTo] = clip(fy, minY, minY + ny, from - fz * z - x1, to - fz * z - x0)
      for (let y = yFrom; y < yTo; y++) {
        const along = fy * y + fz * z
        const [lo, hi] = clip(fx, minX, minX + nx, from - along, to - along)
        const row = ((z - minZ) * ny + (y - minY)) * (nx / 2)
        for (let x = lo + ((lo + y + z) & 1); x < hi; x += 2) {
          if (cells[row + ((x - minX) >> 1)] !== 0) count++
        }
      }
    }
    return count
  }

  /** Calls `visit` with every voxel's position and material id, ordered by z, then y, then x. */
  forEach(visit: (x: number, y: number, z: number, id: number) => void) {
    const { minX, minY, minZ, nx, ny, nz, cells } = this
    let i = 0
    for (let z = minZ; z < minZ + nz; z++) {
      for (let y = minY; y < minY + ny; y++) {
        for (let x = minX + ((minX + y + z) & 1); x < minX + nx; x += 2, i++) {
          if (cells[i] !== 0) visit(x, y, z, cells[i])
        }
      }
    }
  }

  /** Every voxel, ordered by z, then y, then x. */
  toVoxels(): Voxel[] {
    const voxels: Voxel[] = []
    this.forEach((x, y, z, id) => {
      const { color, type } = this.materials[id]
      voxels.push({ x, y, z, color, type })
    })
    return voxels
  }

  /** The smallest grid holding `voxels`, which must be sites; where two share a site, the later one wins. */
  static fromVoxels(voxels: readonly Voxel[]): VoxelGrid {
    const box = voxels.length === 0
      ? { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 }
      : { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity }
    for (const { x, y, z } of voxels) {
      if (!isSite(x, y, z)) throw new RangeError(`(${String(x)}, ${String(y)}, ${String(z)}) is not a lattice site`)
      box.minX = Math.min(box.minX, x)
      box.minY = Math.min(box.minY, y)
      box.minZ = Math.min(box.minZ, z)
      box.maxX = Math.max(box.maxX, x + 1)
      box.maxY = Math.max(box.maxY, y + 1)
      box.maxZ = Math.max(box.maxZ, z + 1)
    }

    const materials: Material[] = [{ color: '#000000', type: 0 }]
    const ids = new Map<string, number>()
    const idOf = ({ color, type }: Voxel) => {
      const key = `${color}|${String(type)}`
      let id = ids.get(key)
      if (id === undefined) {
        id = materials.push({ color, type }) - 1
        ids.set(key, id)
      }
      return id
    }
    const voxelIds = voxels.map(idOf)
    const grid = new VoxelGrid(box, materials)
    voxels.forEach(({ x, y, z }, n) => { grid.cells[grid.index(x, y, z)] = voxelIds[n] })
    return grid
  }
}

/**
 * The sites of `grid` in a face's lattice coordinates (a, b, c) (see Face
 * in view.ts). `min` and `max` bound them (inclusive); `at` reads a
 * material id, 0 if empty, outside or not a site.
 */
export function faceReader(grid: VoxelData, { right: R, up: U, forward: F }: Basis): {
  min: Vec3
  max: Vec3
  at: (a: number, b: number, c: number) => number
} {
  const { minX, minY, minZ, nx, ny, nz, cells } = grid
  // A linear map is extreme at the box's corners.
  const corners = [minX, minX + nx - 1].flatMap(x => [minY, minY + ny - 1].flatMap(y => [minZ, minZ + nz - 1].map(z => ({ x, y, z }))))
  const dot = (p: Vec3, v: Vec3) => p.x * v.x + p.y * v.y + p.z * v.z
  const range = (v: Vec3) => corners.map(p => dot(p, v))
  const [as, bs, cs] = [range(R), range(U), range(F)]
  const half = nx / 2
  const at = (a: number, b: number, c: number): number => {
    if (((a ^ c) | (b ^ c)) & 1) return 0
    const x = (a * R.x + c * F.x) / 2 + b * U.x - minX
    const y = (a * R.y + c * F.y) / 2 + b * U.y - minY
    const z = (a * R.z + c * F.z) / 2 + b * U.z - minZ
    if (x < 0 || x >= nx || y < 0 || y >= ny || z < 0 || z >= nz) return 0
    return cells[(z * ny + y) * half + (x >> 1)]
  }
  return {
    min: { x: Math.min(...as), y: Math.min(...bs), z: Math.min(...cs) },
    max: { x: Math.max(...as), y: Math.max(...bs), z: Math.max(...cs) },
    at,
  }
}
