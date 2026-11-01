import { describe, it, expect } from 'vitest'
import { sliceSurface, shadedPalette, chunkFaces, fillFaces, FACE, FACE_SHADE, RECORD } from './bake'
import { chunkWidth } from './slice-selection'
import { FACES } from './view'
import { VoxelGrid } from './voxel-grid'
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
        // Goes on past the slice's near or far plane.
        const on = (z === depth && world.has(x, y, z - 1) ? 32 : 0) | (z === depth + size - 1 && world.has(x, y, z + 1) ? 64 : 0)
        return open ? [[x, y, z, open | on].join()] : []
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

describe('shadedPalette', () => {
  it('shades each face kind by the way it faces in the world', () => {
    const white = [{ color: '#000000', type: 0 }, { color: '#ffffff', type: 1 }]
    const { front, back, left, right, bottom, top } = FACE_SHADE
    // Kinds: front (towards the camera), left, right, bottom, top, in the face's coordinates.
    const expected: Record<string, number[]> = {
      '+z': [front, left, right, bottom, top],
      '+x': [left, back, front, bottom, top],
      '+y': [bottom, left, right, back, front],
    }
    for (const face of FACES.filter(f => f.name in expected)) {
      const reds = [...shadedPalette(white, face).slice(5)].map(rgba => rgba & 255)
      expect(reds).toEqual(expected[face.name].map(shade => Math.round(255 * shade)))
    }
  })
})

describe('chunkFaces', () => {
  it('grows only side faces on a slice plane their voxel goes on past', () => {
    // A floor through slices [0, 4) and [4, 8), baked straight along z, so its
    // top faces show only grown.
    const floor = VoxelGrid.fromVoxels(Array.from({ length: 16 * 8 }, (_, i) => (
      { x: i % 16, y: 0, z: Math.floor(i / 16), color: '#808080', type: 1 })))
    const surface = sliceSurface(floor, 0, 4)
    const { data, count } = chunkFaces(surface, 0, 0, 0, 0, 27)
    const grown = Array.from({ length: count }, (_, f) => f * FACE)
      .filter(o => data.subarray(o + 7, o + 11).some(g => g > 0))
      .map(o => ({ front: data[o + 4] % 5 === 0, z: surface.records[data[o + 5] * RECORD + 2] }))
    expect(grown.length).toBeGreaterThan(0)
    expect(grown.every(({ front, z }) => !front && z === 3)).toBe(true)
  })
})

describe('fillFaces', () => {
  it('paints reached faces, then grows every face only into empty pixels', () => {
    // At 1 px per unit from (0, 4). Each face: rectangle, colour, record,
    // reached, growth left, bottom, right, top.
    const data = Float64Array.from([
      0, 0, 1, 1, 0xa, 0, 1, 0, 0, 1, 1, // grown right and up
      1, 0, 2, 1, 0xb, 1, 1, 0, 0, 0, 0, // painted after 0xa, not grown
      2, 2, 3, 2, 0xc, 2, 0, 0, 0, 0, 1, // not reached, flat: only its growth shows
    ])
    expect(data.length).toBe(3 * FACE)
    const faces = { data, count: 3, minX: 0, maxX: 3, minY: 0, maxY: 3 }
    const palette = Uint32Array.from({ length: 0xd }, (_, i) => i)
    const pixels = new Uint32Array(4 * 4)
    expect(fillFaces(faces, palette, pixels, 4, 4, 0, 4, 1)).toBe(3)
    expect(Array.from(pixels)).toEqual([
      0, 0, 0, 0,
      0, 0, 0xc, 0,
      0xa, 0xa, 0, 0,
      0xa, 0xb, 0, 0,
    ])
  })
})
