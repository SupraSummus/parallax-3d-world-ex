import { describe, it, expect } from 'vitest'
import { selectSlices, getSliceAtDepth, clampDepthMultiplier } from './slice-selection'

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
  // DESIGN.md "Slice Progression Example" tables.
  it('matches the documented progression for camera z=0', () => {
    expect(selectSlices(0, 1, 200)).toEqual([
      { depth: 1, size: 1 },
      { depth: 2, size: 2 },
      { depth: 4, size: 4 },
      { depth: 8, size: 8 },
      { depth: 16, size: 16 },
      { depth: 32, size: 32 },
      { depth: 64, size: 64 },
      { depth: 128, size: 64 },
      { depth: 192, size: 64 },
    ])
  })

  it('matches the documented progression for camera z=-67', () => {
    const slices = selectSlices(-67, 1, 200)
    expect(slices.map(s => s.depth)).toEqual([-66, -65, -64, -62, -60, -56, -48, -32, 0, 64, 128])
    expect(sizes(slices)).toEqual([1, 1, 2, 2, 4, 8, 16, 32, 64, 64, 64])
  })

  it('returns nothing for an empty range', () => {
    expect(selectSlices(0, 200, 100)).toEqual([])
    expect(selectSlices(0.5, 10, 10)).toEqual([])
  })

  it('defaults to multiplier 2', () => {
    expect(selectSlices(-30, 1, 200)).toEqual(selectSlices(-30, 1, 200, 2))
  })

  describe.each([1.5, 2, 3, 4])('invariants with multiplier %s', multiplier => {
    const cameras = Array.from({ length: 81 }, (_, i) => -200 + i * 5.13)

    it.each(cameras)('camera z=%s', cameraZ => {
      const slices = selectSlices(cameraZ, 1, 200, multiplier)

      // Covers [cameraZ + 1, cameraZ + 200) contiguously.
      expect(slices[0].depth).toBeLessThanOrEqual(cameraZ + 1)
      expect(slices[0].depth + slices[0].size).toBeGreaterThan(cameraZ + 1)
      const last = slices[slices.length - 1]
      expect(last.depth + last.size).toBeGreaterThanOrEqual(cameraZ + 200)
      for (let i = 1; i < slices.length; i++) {
        expect(slices[i].depth).toBe(slices[i - 1].depth + slices[i - 1].size)
      }

      for (const s of slices) {
        // Aligned, so a (depth, size) slice is camera-independent and cacheable.
        expect(Math.abs(s.depth % s.size)).toBe(0)
        // Every slice is in front of the camera.
        expect(s.depth + s.size / 2).toBeGreaterThan(cameraZ)
      }

      // Logarithmic, not linear, in the view distance.
      expect(slices.length).toBeLessThan(25)
    })
  })

  it('uses thicker slices farther from the camera', () => {
    for (const cameraZ of [-100, -67, -30, 0, 17]) {
      const slices = selectSlices(cameraZ, 1, 200)
      expect(slices[0].size).toBeLessThanOrEqual(2)
      for (const s of slices) {
        if (s.depth - cameraZ > 50) expect(s.size).toBeGreaterThan(1)
      }
      expect(slices[slices.length - 1].size).toBeGreaterThanOrEqual(32)
    }
  })
})

describe('clampDepthMultiplier', () => {
  it('clamps to the supported range', () => {
    expect(clampDepthMultiplier(0.5)).toBe(1.2)
    expect(clampDepthMultiplier(2.5)).toBe(2.5)
    expect(clampDepthMultiplier(10)).toBe(4)
  })
})
