import { describe, it, expect } from 'vitest'
import { selectSlices, getSliceAtDepth, leakFreeDetail, matchTilings } from './slice-selection'

const sizes = (slices: { size: number }[]) => slices.map(s => s.size)

describe('getSliceAtDepth', () => {
  it('returns the smallest aligned size >= minSize', () => {
    expect(getSliceAtDepth(0, 1).size).toBe(1)
    expect(getSliceAtDepth(0, 4).size).toBe(4)
    expect(getSliceAtDepth(0, 64).size).toBe(64)
    expect(getSliceAtDepth(8, 3).size).toBe(4)
    expect(getSliceAtDepth(-16, 16).size).toBe(16)
  })

  it('falls back to the largest aligned size when minSize is not available', () => {
    expect(getSliceAtDepth(8, 16).size).toBe(8)
    expect(getSliceAtDepth(6, 4).size).toBe(2)
    expect(getSliceAtDepth(7, 64).size).toBe(1)
  })

  it('caps sizes at 64', () => {
    expect(getSliceAtDepth(0, 1000).size).toBe(64)
  })
})

describe('selectSlices', () => {
  // docs/architecture.md, section 1 (detail 1).
  it('matches the documented progression for camera z=0', () => {
    const slices = selectSlices(0, 1, 200, 1)
    expect(slices.map(s => s.depth)).toEqual([1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192])
    expect(sizes(slices)).toEqual([1, 1, 1, 2, 2, 4, 4, 8, 8, 16, 16, 32, 32, 64, 64])
  })

  it('matches the documented progression for camera z=-67', () => {
    const slices = selectSlices(-67, 1, 200, 1)
    expect(slices.map(s => s.depth)).toEqual([-66, -65, -64, -63, -62, -60, -56, -48, -32, 0, 64, 128])
    expect(sizes(slices)).toEqual([1, 1, 1, 1, 2, 4, 8, 16, 32, 64, 64, 64])
  })

  it('returns nothing for an empty range', () => {
    expect(selectSlices(0, 200, 100, 4)).toEqual([])
    expect(selectSlices(0.5, 10, 10, 4)).toEqual([])
  })

  it('makes slices thinner as detail increases', () => {
    const counts = [1, 2, 4, 8, 16].map(detail => selectSlices(-30, 1, 200, detail).length)
    expect(counts).toEqual([...counts].sort((a, b) => a - b))
    expect(new Set(counts).size).toBe(counts.length)
  })

  describe.each([1, 2, 4, 8, 16])('invariants with detail %s', detail => {
    const cameras = Array.from({ length: 81 }, (_, i) => -200 + i * 5.13)

    it.each(cameras)('camera z=%s', cameraZ => {
      const slices = selectSlices(cameraZ, 1, 200, detail)

      // Covers voxels with z in [cameraZ + 1, cameraZ + 200) contiguously; none
      // nearer, as a slice close to the camera would be blown up over the screen.
      expect(slices[0].depth).toBeGreaterThanOrEqual(cameraZ + 1)
      expect(slices[0].depth - 1).toBeLessThan(cameraZ + 1)
      const last = slices[slices.length - 1]
      expect(last.depth + last.size).toBeGreaterThanOrEqual(cameraZ + 200)
      for (let i = 1; i < slices.length; i++) {
        expect(slices[i].depth).toBe(slices[i - 1].depth + slices[i - 1].size)
      }

      for (const s of slices) {
        // Aligned powers of two, so a (depth, size) slice is camera-independent and cacheable.
        expect(Math.abs(s.depth % s.size)).toBe(0)
        expect([1, 2, 4, 8, 16, 32, 64]).toContain(s.size)
        // Never thicker (a voxel reaches 1 past its layer: size + 1) than
        // (distance to the near side) / detail, or one layer (two units).
        expect(s.size + 1).toBeLessThanOrEqual(Math.max(2, (s.depth - 1 - cameraZ) / detail))
      }

      // Logarithmic, not linear, in the view distance.
      expect(slices.length).toBeLessThanOrEqual(7 * detail + 10)
    })
  })

  it('uses thicker slices farther from the camera', () => {
    for (const cameraZ of [-100, -67, -30, 0, 17]) {
      const slices = selectSlices(cameraZ, 1, 200, 1)
      expect(slices[0].size).toBeLessThanOrEqual(2)
      for (const s of slices) {
        if (s.depth - cameraZ > 50) expect(s.size).toBeGreaterThan(1)
      }
      expect(slices[slices.length - 1].size).toBeGreaterThanOrEqual(32)
    }
  })
})

// That the bound holds is leak-bound.test.ts; these pin the formula's two cases.
describe('leakFreeDetail', () => {
  it('is √(C·focal/ε) when chunk directions beat the field of view', () => {
    // 1280 px wide at 90°: focal 640. √(16 · 640 / 16) = 25.3, rounded up to a quarter octave.
    expect(leakFreeDetail(640, 1, 16)).toBe(2 ** 4.75)
  })

  it('is tan(fov / 2)·focal/ε when the view is narrower', () => {
    // 0.25 · 640 / 16 = 10, rounded up.
    expect(leakFreeDetail(640, 0.25, 16)).toBe(2 ** 3.5)
  })
})

describe('matchTilings', () => {
  const tiling = (...sizes: number[]) => sizes.reduce<{ depth: number; size: number }[]>((slices, size) => {
    const depth = slices.length === 0 ? 0 : slices[slices.length - 1].depth + slices[slices.length - 1].size
    return [...slices, { depth, size }]
  }, [])
  const layers = (slices: { depth: number; size: number }[]) => slices.length === 0 ? null : [slices[0].depth, slices[slices.length - 1].depth + slices[slices.length - 1].size]

  it('pairs segments ending at boundaries both tilings share, with the slices holding the same layers', () => {
    // [0, 1, 2, 4, 8) against [0, 2, 3, 4, 8).
    const segments = matchTilings(tiling(1, 1, 2, 4), tiling(2, 1, 1, 4))
    expect(segments.map(s => [layers(s.wanted), layers(s.previous)])).toEqual([[[0, 2], [0, 2]], [[2, 4], [2, 4]], [[4, 8], [4, 8]]])
    expect(segments[1].previous.map(s => s.size)).toEqual([1, 1])
  })

  it('lets the first segment start within a previous slice, and pairs nothing beyond the previous tiling', () => {
    // The camera moved forward: wanted starts at 1, previous at 0 and ends at 4.
    const wanted = tiling(1, 1, 2, 4, 8).slice(1)
    const segments = matchTilings(wanted, tiling(2, 2))
    expect(segments.map(s => [layers(s.wanted), layers(s.previous)])).toEqual([[[1, 2], [0, 2]], [[2, 4], [2, 4]], [[4, 16], null]])
  })

  it('covers every wanted slice once, in order, for any two tilings', () => {
    for (let cameraZ = -40; cameraZ < 40; cameraZ += 3) {
      for (const previousZ of [cameraZ - 5, cameraZ, cameraZ + 7]) {
        const wanted = selectSlices(cameraZ, 1, 300, 2)
        const previous = selectSlices(previousZ, 1, 300, 2)
        const segments = matchTilings(wanted, previous)
        expect(segments.flatMap(s => s.wanted)).toEqual(wanted)
        for (const { wanted: w, previous: p } of segments) {
          if (p.length === 0) continue
          expect(layers(p)?.[1]).toBe(layers(w)?.[1])
          expect(p[0].depth).toBeLessThanOrEqual(w[0].depth)
        }
      }
    }
  })
})
