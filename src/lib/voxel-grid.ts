/**
 * Dense voxel storage: a box of cells, one material id per cell (0 = empty).
 * Plain typed arrays and integer ids, the same layout in TS or Rust/WASM.
 */

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

/**
 * Cells are laid out z-major, then y, then x: cell (x, y, z) is
 * cells[((z - minZ) · ny + (y - minY)) · nx + (x - minX)], so a z-slice is one
 * contiguous range and the neighbours of cell i are i ± 1 (x), i ± nx (y)
 * and i ± nx · ny (z).
 */
export class VoxelGrid {
  readonly minX: number
  readonly minY: number
  readonly minZ: number
  readonly nx: number
  readonly ny: number
  readonly nz: number
  /** Material id per cell; 0 is empty. */
  readonly cells: Uint8Array
  /** Material of each id; entry 0 (empty) is unused. */
  readonly materials: readonly Material[]

  constructor(box: Box, materials: readonly Material[]) {
    if (materials.length > MAX_MATERIALS) throw new RangeError(`at most ${String(MAX_MATERIALS)} materials`)
    this.minX = box.minX
    this.minY = box.minY
    this.minZ = box.minZ
    this.nx = Math.max(0, box.maxX - box.minX)
    this.ny = Math.max(0, box.maxY - box.minY)
    this.nz = Math.max(0, box.maxZ - box.minZ)
    this.cells = new Uint8Array(this.nx * this.ny * this.nz)
    this.materials = materials
  }

  /** Index of cell (x, y, z) in `cells`, or -1 outside the box. */
  index(x: number, y: number, z: number): number {
    const i = x - this.minX
    const j = y - this.minY
    const k = z - this.minZ
    if (i < 0 || i >= this.nx || j < 0 || j >= this.ny || k < 0 || k >= this.nz) return -1
    return (k * this.ny + j) * this.nx + i
  }

  /** Material id at (x, y, z); 0 if empty or outside the box. */
  get(x: number, y: number, z: number): number {
    const i = this.index(x, y, z)
    return i < 0 ? 0 : this.cells[i]
  }

  /** Number of voxels with z in [fromZ, toZ). */
  countInZ(fromZ: number, toZ: number): number {
    const plane = this.nx * this.ny
    const end = (Math.min(toZ, this.minZ + this.nz) - this.minZ) * plane
    let count = 0
    for (let i = Math.max(0, fromZ - this.minZ) * plane; i < end; i++) if (this.cells[i] !== 0) count++
    return count
  }

  /** Every voxel, ordered by z, then y, then x. */
  toVoxels(): Voxel[] {
    const voxels: Voxel[] = []
    let i = 0
    for (let z = this.minZ; z < this.minZ + this.nz; z++) {
      for (let y = this.minY; y < this.minY + this.ny; y++) {
        for (let x = this.minX; x < this.minX + this.nx; x++, i++) {
          const id = this.cells[i]
          if (id === 0) continue
          const { color, type } = this.materials[id]
          voxels.push({ x, y, z, color, type })
        }
      }
    }
    return voxels
  }

  /** The smallest grid holding `voxels`; where two share a cell, the later one wins. */
  static fromVoxels(voxels: readonly Voxel[]): VoxelGrid {
    const box = voxels.length === 0
      ? { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 }
      : { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity }
    for (const { x, y, z } of voxels) {
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
