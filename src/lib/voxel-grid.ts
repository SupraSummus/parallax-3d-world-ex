/**
 * Dense voxel storage: a box of cells, one material id per cell (0 = empty).
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

  /**
   * Number of voxels whose coordinate along `axis` (a unit vector along a
   * world axis) is in [from, to): a slice of the grid turned by
   * rotateGrid() with that axis as `forward`.
   */
  countAlong(axis: Vec3, from: number, to: number): number {
    const lo = [this.minX, this.minY, this.minZ]
    const hi = [this.minX + this.nx, this.minY + this.ny, this.minZ + this.nz]
    // Clip the box along the axis's dimension k, counting from the far end for a negative axis.
    const k = axis.x !== 0 ? 0 : axis.y !== 0 ? 1 : 2
    const sign = [axis.x, axis.y, axis.z][k]
    lo[k] = Math.max(lo[k], sign > 0 ? from : 1 - to)
    hi[k] = Math.min(hi[k], sign > 0 ? to : 1 - from)
    let count = 0
    for (let z = lo[2]; z < hi[2]; z++) {
      for (let y = lo[1]; y < hi[1]; y++) {
        const row = ((z - this.minZ) * this.ny + (y - this.minY)) * this.nx - this.minX
        for (let x = lo[0]; x < hi[0]; x++) if (this.cells[row + x] !== 0) count++
      }
    }
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

/**
 * The grid in the coordinates of `axes`, unit vectors along world axes:
 * its cell (x, y, z) is the grid's cell x · right + y · up + z · forward.
 * The identity is the grid itself.
 */
export function rotateGrid(grid: VoxelData, { right, up, forward }: Basis): VoxelData {
  if (right.x === 1 && up.y === 1 && forward.z === 1) return grid
  const { minX, minY, minZ, nx, ny, nz, cells } = grid
  const range = (a: Vec3) => {
    const ends = [a.x * minX + a.y * minY + a.z * minZ, a.x * (minX + nx - 1) + a.y * (minY + ny - 1) + a.z * (minZ + nz - 1)]
    return { min: Math.min(...ends), max: Math.max(...ends) + 1 }
  }
  const [rx, ry, rz] = [range(right), range(up), range(forward)]
  const turned = new VoxelGrid({ minX: rx.min, minY: ry.min, minZ: rz.min, maxX: rx.max, maxY: ry.max, maxZ: rz.max }, grid.materials)
  if (cells.length === 0) return turned
  let i = 0
  for (let z = minZ; z < minZ + nz; z++) {
    for (let y = minY; y < minY + ny; y++) {
      for (let x = minX; x < minX + nx; x++, i++) {
        const id = cells[i]
        if (id === 0) continue
        const u = right.x * x + right.y * y + right.z * z
        const v = up.x * x + up.y * y + up.z * z
        const w = forward.x * x + forward.y * y + forward.z * z
        turned.cells[((w - turned.minZ) * turned.ny + (v - turned.minY)) * turned.nx + (u - turned.minX)] = id
      }
    }
  }
  return turned
}
