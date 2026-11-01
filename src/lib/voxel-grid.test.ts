import { describe, it, expect } from 'vitest'
import { FACES } from './view'
import { VoxelGrid, faceReader, isSite } from './voxel-grid'
import { World } from './world'

const { grid, voxels } = new World(7, 'hills_with_trees')

describe('VoxelGrid', () => {
  it('stores the sites of its box, one per pair of x, and nothing else', () => {
    const box = new VoxelGrid({ minX: -3, minY: 0, minZ: 0, maxX: 4, maxY: 3, maxZ: 2 }, [])
    // Widened to start and end on an even x.
    expect([box.minX, box.nx]).toEqual([-4, 8])
    const indices = new Set<number>()
    for (let z = 0; z < 2; z++) {
      for (let y = 0; y < 3; y++) {
        for (let x = -4; x < 4; x++) {
          const i = box.index(x, y, z)
          expect(i >= 0).toBe(isSite(x, y, z))
          if (i >= 0) indices.add(i)
        }
      }
    }
    expect(indices.size).toBe(box.cells.length)
    expect(Math.max(...indices)).toBe(box.cells.length - 1)
  })

  it('round-trips voxels, and refuses points that are not sites', () => {
    const list = [{ x: 0, y: 0, z: 0, color: '#ff0000', type: 1 }, { x: 3, y: -1, z: 2, color: '#00ff00', type: 2 }]
    expect(VoxelGrid.fromVoxels(list).toVoxels()).toEqual(list)
    expect(() => VoxelGrid.fromVoxels([{ x: 1, y: 0, z: 0, color: '#ff0000', type: 1 }])).toThrow(RangeError)
  })
})

const dot = (p: { x: number; y: number; z: number }, v: { x: number; y: number; z: number }) => p.x * v.x + p.y * v.y + p.z * v.z

describe('faceReader', () => {
  it("reads every voxel at its lattice coordinates, within the face's bounds", () => {
    for (const face of FACES) {
      const { min, max, at } = faceReader(grid, face.lattice)
      const { right, up, forward } = face.lattice
      const misplaced = voxels.filter(v => {
        const [a, b, c] = [dot(v, right), dot(v, up), dot(v, forward)]
        const inside = a >= min.x && a <= max.x && b >= min.y && b <= max.y && c >= min.z && c <= max.z
        return !inside || at(a, b, c) !== grid.get(v.x, v.y, v.z)
      })
      expect(misplaced).toEqual([])
    }
  })

  it('reads empty outside the grid and off the lattice', () => {
    const { min, at } = faceReader(grid, FACES[0].lattice)
    expect(at(min.x - 2, min.y, min.z)).toBe(0)
    const { right, up, forward } = FACES[0].lattice
    const v = voxels[0]
    expect(at(dot(v, right) + 1, dot(v, up), dot(v, forward))).toBe(0)
  })
})

describe('countAlong', () => {
  it('counts the voxels of a slice of layers', () => {
    for (const face of FACES) {
      for (const [from, to] of [[-3, 5], [0, 64], [-100, -40]]) {
        const inSlice = voxels.filter(v => { const c = dot(v, face.lattice.forward); return c >= from && c < to })
        expect(grid.countAlong(face.lattice.forward, from, to)).toBe(inSlice.length)
      }
    }
  })
})
