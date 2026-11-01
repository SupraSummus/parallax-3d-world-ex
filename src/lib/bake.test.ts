import { describe, it, expect } from 'vitest'
import { sliceSurface, RECORD } from './bake'
import { chunkWidth } from './slice-selection'
import { World } from './world'

describe('sliceSurface', () => {
  it('matches a brute-force scan: open faces, grouped by cell, far to near', () => {
    const world = new World(7, 'hills_with_trees')
    for (const [depth, size] of [[-40, 8], [-3, 1], [0, 64], [30, 16], [100, 4]]) {
      const inSlice = world.voxels.filter(v => v.z >= depth && v.z < depth + size)
      const expected = inSlice.flatMap(({ x, y, z }) => {
        const open = (z === depth || !world.has(x, y, z - 1) ? 1 : 0) |
          (world.has(x - 1, y, z) ? 0 : 2) | (world.has(x + 1, y, z) ? 0 : 4) |
          (world.has(x, y - 1, z) ? 0 : 8) | (world.has(x, y + 1, z) ? 0 : 16)
        return open ? [[x, y, z, open].join()] : []
      })

      const surface = sliceSurface(world.grid, depth, size)
      const w = chunkWidth(size)
      const actual: string[] = []
      for (let k = 0; k < surface.cellsX * surface.cellsY; k++) {
        let lastZ = Infinity
        for (let r = surface.cellStart[k]; r < surface.cellStart[k + 1]; r++) {
          const [x, y, z, , open] = surface.records.subarray(r * RECORD, (r + 1) * RECORD)
          expect((Math.floor(y / w) - surface.cellY) * surface.cellsX + Math.floor(x / w) - surface.cellX).toBe(k)
          expect(z).toBeLessThanOrEqual(lastZ)
          lastZ = z
          actual.push([x, y, z, open].join())
        }
      }
      expect(actual.sort()).toEqual(expected.sort())
      expect(surface.voxelCount).toBe(inSlice.length)
    }
  })
})
