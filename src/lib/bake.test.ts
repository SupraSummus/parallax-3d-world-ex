import { describe, it, expect } from 'vitest'
import { fillConvex } from './bake'

describe('fillConvex', () => {
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
          fillConvex(pixels, W, H, [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)], 1)
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
