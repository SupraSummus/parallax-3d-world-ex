/**
 * Dense voxel storage on the face-centred cubic (FCC) lattice: one material
 * id per site of a box (0 = empty). Sites are the integer points with
 * x + y + z even; each is the centre of a rhombic dodecahedron (fcc.ts).
 * Plain typed arrays and integer ids, the same layout in TS or Rust/WASM.
 */

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

/** Width of a column block of LayerIndex, in lattice units along a. */
const EXTENT_BLOCK = 8

/** A face's lattice vectors R, U, F (see Face in view.ts). */
interface Lattice {
  right: Vec3
  up: Vec3
  forward: Vec3
}

/** Per face whose forward has its first non-zero component positive. */
interface Table {
  lattice: Lattice
  cMin: number
  aMin: number
  layers: number
  blocks: number
  /** Voxels before each layer (c − cMin), and in all of them at the end. */
  sums: Float64Array
  /** By (c − cMin, block of a − aMin): the least and greatest b, or least > greatest if there is no voxel. */
  low: Int16Array
  high: Int16Array
}

/**
 * Where a grid's voxels are along each face's layers (in a face's lattice
 * coordinates (a, b, c), see Face in view.ts): how many each layer c holds,
 * and for each layer and block of EXTENT_BLOCK columns a, the range of b
 * of its voxels. From one pass over the grid, so the renderer can count a
 * slice's voxels, and tell which chunk cells are empty and how high their
 * content reaches, without walking or baking them.
 */
export class LayerIndex {
  private keys: string[]
  private tables: Table[]

  constructor({ minX, minY, minZ, nx, ny, nz, cells }: VoxelData, lattices: readonly Lattice[]) {
    // Bounds of v · p over the grid's box.
    const along = (v: Vec3) => {
      const ends = [0, 1].flatMap(i => [0, 1].flatMap(j => [0, 1].map(k =>
        v.x * (minX + i * Math.max(0, nx - 1)) + v.y * (minY + j * Math.max(0, ny - 1)) + v.z * (minZ + k * Math.max(0, nz - 1)))))
      return [Math.min(...ends), Math.max(...ends)]
    }
    // A table per pair of opposite faces (see table()).
    const canonical = lattices.filter(l => !LayerIndex.mirrored(l.forward))
    const shapes = canonical.filter((l, k) => canonical.findIndex(m => LayerIndex.key(m.forward) === LayerIndex.key(l.forward)) === k).map(lattice => {
      const [aMin, aMax] = along(lattice.right)
      const [cMin, cMax] = along(lattice.forward)
      return { lattice, aMin, cMin, layers: cMax - cMin + 1, blocks: Math.floor((aMax - aMin) / EXTENT_BLOCK) + 1 }
    })
    // All tables' arrays in one, for one pass over the grid.
    const n = shapes.length
    const [sumAt, lowAt] = [new Int32Array(n + 1), new Int32Array(n + 1)]
    shapes.forEach(({ layers, blocks }, k) => {
      sumAt[k + 1] = sumAt[k] + layers + 1
      lowAt[k + 1] = lowAt[k] + layers * blocks
    })
    const sums = new Float64Array(sumAt[n])
    const low = new Int16Array(lowAt[n]).fill(32767)
    const high = new Int16Array(lowAt[n]).fill(-32768)
    const blocks = Int32Array.from(shapes, s => s.blocks)
    // Per table: a, b and c of site p are v · p − offset, for v = R, U, F.
    const vectors = Int32Array.from(shapes.flatMap(({ lattice: { right: R, up: U, forward: F } }) => [R, U, F].flatMap(v => [v.x, v.y, v.z])))
    const offsets = Int32Array.from(shapes.flatMap(s => [s.aMin, 0, s.cMin]))
    // a, b and c of the row's first site, per table.
    const row = new Int32Array(3 * n)
    let i = 0
    for (let z = minZ; z < minZ + nz; z++) {
      for (let y = minY; y < minY + ny; y++) {
        const x0 = minX + ((minX + y + z) & 1)
        for (let m = 0; m < 3 * n; m++) row[m] = vectors[3 * m] * x0 + vectors[3 * m + 1] * y + vectors[3 * m + 2] * z - offsets[m]
        for (let x = x0; x < minX + nx; x += 2, i++) {
          if (cells[i] === 0) continue
          const dx = x - x0
          for (let k = 0; k < n; k++) {
            const v = 9 * k
            const a = row[3 * k] + vectors[v] * dx
            const b = row[3 * k + 1] + vectors[v + 3] * dx
            const c = row[3 * k + 2] + vectors[v + 6] * dx
            sums[sumAt[k] + c + 1]++
            // a ≥ 0 here, and EXTENT_BLOCK is 8.
            const at = lowAt[k] + c * blocks[k] + (a >> 3)
            if (b < low[at]) low[at] = b
            if (b > high[at]) high[at] = b
          }
        }
      }
    }
    this.tables = shapes.map((shape, k) => {
      const table = { ...shape, sums: sums.subarray(sumAt[k], sumAt[k + 1]), low: low.subarray(lowAt[k], lowAt[k + 1]), high: high.subarray(lowAt[k], lowAt[k + 1]) }
      for (let c = 1; c < table.sums.length; c++) table.sums[c] += table.sums[c - 1]
      return table
    })
    this.keys = shapes.map(s => LayerIndex.key(s.lattice.forward))
  }

  /** Whether a face's forward is the opposite of one with its first non-zero component positive. */
  private static mirrored({ x, y, z }: Vec3): boolean {
    return (x || y || z) < 0
  }

  private static key({ x, y, z }: Vec3): string {
    const s = (x || y || z) < 0 ? -1 : 1
    return `${String(s * x)},${String(s * y)},${String(s * z)}`
  }

  /**
   * The face's table, and [c0, c1) and [a0, a1) in its coordinates: the
   * opposite face has the same up, and a and c negated, so c in [c0, c1)
   * is −c in [1 − c1, 1 − c0).
   */
  private table({ forward }: { forward: Vec3 }, c0: number, c1: number, a0: number, a1: number): [Table, number, number, number, number] {
    const table = this.tables[this.keys.indexOf(LayerIndex.key(forward))]
    return LayerIndex.mirrored(forward) ? [table, 1 - c1, 1 - c0, 1 - a1, 1 - a0] : [table, c0, c1, a0, a1]
  }

  /** Number of voxels in a face's layers [from, to): a slice's. */
  count(lattice: { forward: Vec3 }, from: number, to: number): number {
    const [{ cMin, sums }, c0, c1] = this.table(lattice, from, to, 0, 0)
    const at = (c: number) => sums[Math.min(sums.length - 1, Math.max(0, c - cMin))]
    return Math.max(0, at(c1) - at(c0))
  }

  /**
   * The least and greatest b of the voxels in a face's layers [c0, c1)
   * with a in [a0, a1) (or a little wider, by whole blocks), or null if
   * there are none.
   */
  range(lattice: { forward: Vec3 }, c0: number, c1: number, a0: number, a1: number): [number, number] | null {
    const [{ cMin, aMin, layers, blocks, low, high }, cFrom, cTo, aFrom, aTo] = this.table(lattice, c0, c1, a0, a1)
    const k0 = Math.max(0, Math.floor((aFrom - aMin) / EXTENT_BLOCK))
    const k1 = Math.min(blocks - 1, Math.floor((aTo - 1 - aMin) / EXTENT_BLOCK))
    let [lo, hi] = [Infinity, -Infinity]
    for (let c = Math.max(cFrom - cMin, 0); c < Math.min(cTo - cMin, layers); c++) {
      for (let k = c * blocks + k0; k <= c * blocks + k1; k++) {
        if (low[k] < lo) lo = low[k]
        if (high[k] > hi) hi = high[k]
      }
    }
    return lo <= hi ? [lo, hi] : null
  }
}
