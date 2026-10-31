import { describe, it, expect } from 'vitest'
import { fillQuad, sliceSurface, RECORD } from './bake'
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

describe('fillQuad', () => {
  // Baked faces tile the canvas edge to edge: neighbours must meet without a
  // gap (background showing through) or an overlap (a face drawn twice).
  it('fills every pixel of a tiling exactly once, and nothing outside it', () => {
    const W = 64
    const H = 48
    let state = 7
    // Multiples of 1/2, as baked corners mostly are (powers of two times
    // integer scales), so that pixel centres often fall exactly on shared
    // edges: the case the half-open rule is for.
    const random = (lo: number, hi: number) =>
      lo + Math.round(((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648) * (hi - lo) * 2) / 2
    for (let trial = 0; trial < 50; trial++) {
      // A random parallelogram, cut into a 4 × 3 grid of parallelograms.
      const origin = [random(5, 15), random(5, 15)]
      const u = [random(10, 14), random(-4, 4)]
      const v = [random(-4, 4), random(9, 12)]
      const at = (i: number, j: number): [number, number] =>
        [origin[0] + i * u[0] + j * v[0], origin[1] + i * u[1] + j * v[1]]

      const counts = new Uint8Array(W * H)
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 3; j++) {
          const pixels = new Uint32Array(W * H)
          fillQuad(pixels, W, H, [...at(i, j), ...at(i + 1, j), ...at(i + 1, j + 1), ...at(i, j + 1)], 1)
          pixels.forEach((p, k) => { counts[k] += p })
        }
      }

      // Where the pixel centre lies in the whole parallelogram, in its own
      // coordinates (s, t) ∈ [0, 4] × [0, 3].
      const det = u[0] * v[1] - u[1] * v[0]
      for (let k = 0; k < W * H; k++) {
        const dx = (k % W) + 0.5 - origin[0]
        const dy = Math.floor(k / W) + 0.5 - origin[1]
        const s = (dx * v[1] - dy * v[0]) / det
        const t = (u[0] * dy - u[1] * dx) / det
        const margin = Math.min(s, 4 - s, t, 3 - t)
        if (Math.abs(margin) < 1e-6) continue // on the outline: either way is fine
        if (counts[k] !== (margin > 0 ? 1 : 0)) expect.fail(`trial ${String(trial)}, pixel ${String(k)}: ${String(counts[k])}`)
      }
    }
  })
})
