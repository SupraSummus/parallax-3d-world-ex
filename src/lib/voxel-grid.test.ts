import { describe, it, expect } from 'vitest'
import { FACES, toLocal } from './view'
import { rotateGrid, type VoxelData } from './voxel-grid'
import { World } from './world'

const { grid, voxels } = new World(7, 'hills_with_trees')

/** Material id at (x, y, z), 0 outside the box. */
function at({ minX, minY, minZ, nx, ny, nz, cells }: VoxelData, x: number, y: number, z: number): number {
  const [i, j, k] = [x - minX, y - minY, z - minZ]
  return i < 0 || i >= nx || j < 0 || j >= ny || k < 0 || k >= nz ? 0 : cells[(k * ny + j) * nx + i]
}

describe('rotateGrid', () => {
  it('puts every voxel at its face coordinates and nothing else', () => {
    for (const face of FACES) {
      const turned = rotateGrid(grid, face)
      const moved = voxels.filter(v => {
        const { x, y, z } = toLocal(face, v)
        return at(turned, x, y, z) !== grid.get(v.x, v.y, v.z)
      })
      expect(moved).toEqual([])
      expect(turned.cells.filter(id => id !== 0)).toHaveLength(voxels.length)
    }
  })
})

describe('countAlong', () => {
  it('counts the voxels of a face slice without turning the grid', () => {
    for (const face of FACES) {
      for (const [from, to] of [[-3, 5], [0, 64], [-100, -40]]) {
        const inSlice = voxels.filter(v => { const z = toLocal(face, v).z; return z >= from && z < to })
        expect(grid.countAlong(face.forward, from, to)).toBe(inSlice.length)
      }
    }
  })
})
