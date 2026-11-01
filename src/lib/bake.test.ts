import { describe, it, expect } from 'vitest'
import { sliceSurface, fillFaces, FACE, RECORD } from './bake'
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
    }
  })
})

describe('fillFaces', () => {
  it('paints faces, then grows them only into empty pixels', () => {
    // At 1 px per unit from (0, 4): face 0xa covers [0, 1]², grown by 1;
    // face 0xb, painted after it, covers [1, 2] × [0, 1], not grown.
    const data = Float64Array.from([0, 0, 1, 1, 0xa, 0, 1, 1, 0, 2, 1, 0xb, 1, 0])
    expect(data.length).toBe(2 * FACE)
    const faces = { data, count: 2, minX: -1, maxX: 2, minY: -1, maxY: 2 }
    const palette = Uint32Array.from({ length: 0xc }, (_, i) => i)
    const pixels = new Uint32Array(4 * 4)
    expect(fillFaces(faces, palette, pixels, 4, 4, 0, 4, 1)).toBe(2)
    expect(Array.from(pixels)).toEqual([
      0, 0, 0, 0,
      0, 0, 0, 0,
      0xa, 0xa, 0, 0,
      0xa, 0xb, 0, 0,
    ])
  })
})
