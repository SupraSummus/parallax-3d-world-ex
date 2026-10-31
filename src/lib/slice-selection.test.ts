import { describe, it, expect } from 'vitest'
import { selectSlices, getSliceAtDepth, leakFreeDetail, type SliceBoundary } from './slice-selection'

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
  // DESIGN.md tables (detail 1).
  it('matches the documented progression for camera z=0', () => {
    expect(selectSlices(0, 1, 200, 1)).toEqual([
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
    const slices = selectSlices(-67, 1, 200, 1)
    expect(slices.map(s => s.depth)).toEqual([-66, -65, -64, -62, -60, -56, -48, -32, 0, 64, 128])
    expect(sizes(slices)).toEqual([1, 1, 2, 2, 4, 8, 16, 32, 64, 64, 64])
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

      // Covers [cameraZ + 1, cameraZ + 200) contiguously.
      expect(slices[0].depth).toBeLessThanOrEqual(cameraZ + 1)
      expect(slices[0].depth + slices[0].size).toBeGreaterThan(cameraZ + 1)
      const last = slices[slices.length - 1]
      expect(last.depth + last.size).toBeGreaterThanOrEqual(cameraZ + 200)
      for (let i = 1; i < slices.length; i++) {
        expect(slices[i].depth).toBe(slices[i - 1].depth + slices[i - 1].size)
      }

      for (const s of slices) {
        // Aligned powers of two, so a (depth, size) slice is camera-independent and cacheable.
        expect(Math.abs(s.depth % s.size)).toBe(0)
        expect([1, 2, 4, 8, 16, 32, 64]).toContain(s.size)
        // Never thicker than distance / detail.
        expect(s.size).toBeLessThanOrEqual(Math.max(1, (s.depth - cameraZ) / detail))
        // Every slice is in front of the camera.
        expect(s.depth + s.size / 2).toBeGreaterThan(cameraZ)
      }

      // Logarithmic, not linear, in the view distance.
      expect(slices.length).toBeLessThan(6 * detail + 10)
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

describe('leakFreeDetail', () => {
  it('is screen size / (2 · max leak), rounded up to a quarter octave', () => {
    expect(leakFreeDetail(1280, 16)).toBe(2 ** 5.5)
    expect(leakFreeDetail(1024, 16)).toBe(32)
    expect(leakFreeDetail(1000, 16)).toBe(32)
    expect(leakFreeDetail(100, 1000)).toBe(1)
  })
})

/**
 * The renderer against true perspective, in 2D: one lateral axis u (think
 * height) and depth z. Voxel (u, z) covers [u - 0.5, u + 0.5] × [z, z + 1].
 * The renderer draws, per slice, the nearest voxel of each u as a unit
 * square scaled by 1 / (distance to the slice centre); nearer slices on top.
 * A leak is a run of screen where the renderer shows a voxel that no
 * perspective ray reaches, measured in pixels of a SCREEN-pixel screen.
 */
describe.each([1, 0.5, 0.25])('occlusion leaks with tan(fov / 2) = %s', TAN_HALF_FOV => {
  interface Cell { u: number; z: number }
  const DEPTH = 300
  const SCREEN = 128
  const MAX_LEAK = 2
  const focal = SCREEN / 2 / TAN_HALF_FOV
  const RAYS = 3000
  const rays = Array.from({ length: RAYS }, (_, i) => -TAN_HALF_FOV + (2 * TAN_HALF_FOV * i) / (RAYS - 1))
  const step = rays[1] - rays[0]

  /** Deterministic heightfield with steps and cliffs, solid down to u = -6. */
  function terrain(seed: number): Cell[] {
    let state = seed
    const random = () => {
      state = (state * 1103515245 + 12345) % 2147483648
      return state / 2147483648
    }
    const cells: Cell[] = []
    let height = 0
    for (let z = 1; z < DEPTH; z++) {
      height += random() < 0.7 ? Math.round(random() * 2 - 1) : Math.round(random() * 8 - 4)
      height = Math.max(-6, Math.min(6, height))
      for (let u = -6; u <= height; u++) cells.push({ u, z })
    }
    return cells
  }

  function perspectiveVisible(cells: Cell[], cu: number, cz: number): Set<number> {
    const nearest = rays.map(() => ({ distance: Infinity, cell: -1 }))
    cells.forEach(({ u, z }, cell) => {
      const lo = u - 0.5 - cu
      const hi = u + 0.5 - cu
      rays.forEach((t, i) => {
        // Depth range over which the ray u = cu + t * d is inside [lo, hi].
        let enter = z - cz
        let exit = z + 1 - cz
        if (t === 0) {
          if (lo > 0 || hi < 0) return
        } else {
          enter = Math.max(enter, Math.min(lo / t, hi / t))
          exit = Math.min(exit, Math.max(lo / t, hi / t))
        }
        if (enter <= exit && enter < nearest[i].distance) nearest[i] = { distance: enter, cell }
      })
    })
    return new Set(nearest.map(n => n.cell))
  }

  function parallaxOwners(cells: Cell[], cu: number, cz: number, slices: SliceBoundary[]): number[] {
    const owner = rays.map(() => -1)
    for (const { depth, size } of [...slices].reverse()) {
      const distance = depth + size / 2 - cz
      const front = new Map<number, number>()
      cells.forEach(({ u, z }, cell) => {
        const current = front.get(u)
        if (z >= depth && z < depth + size && (current === undefined || z < cells[current].z)) front.set(u, cell)
      })
      for (const [u, cell] of front) {
        const first = Math.ceil(((u - 0.5 - cu) / distance + TAN_HALF_FOV) / step)
        const last = Math.floor(((u + 0.5 - cu) / distance + TAN_HALF_FOV) / step)
        for (let i = Math.max(0, first); i <= Math.min(RAYS - 1, last); i++) owner[i] = cell
      }
    }
    return owner
  }

  /** Every leak: its width in screen pixels and in voxels at its nearest leaked voxel. */
  function leaks(cells: Cell[], cu: number, cz: number, detail: number): { pixels: number; voxels: number }[] {
    const visible = perspectiveVisible(cells, cu, cz)
    const owner = parallaxOwners(cells, cu, cz, selectSlices(cz, 1, DEPTH, detail))
    const runs: { rays: number; distance: number }[] = []
    let run: { rays: number; distance: number } | null = null
    for (const cell of owner) {
      if (cell >= 0 && !visible.has(cell)) {
        run ??= { rays: 0, distance: Infinity }
        run.rays++
        run.distance = Math.min(run.distance, cells[cell].z + 0.5 - cz)
      } else if (run) {
        runs.push(run)
        run = null
      }
    }
    if (run) runs.push(run)
    return runs.map(r => ({ pixels: r.rays * step * focal, voxels: r.rays * step * r.distance }))
  }

  // Camera above the terrain looking over it, like the lake world.
  const scenes = [1, 2, 3, 4].map(seed => ({ cells: terrain(seed), cu: 6 + seed * 3.7, cz: -0.1 - seed * 0.2 }))
  const detail = leakFreeDetail(SCREEN, MAX_LEAK)
  // Within the leak bound, give or take one ray. Slices are at least one
  // voxel thick, so near the camera (closer than `detail`) the bound is
  // tan(fov / 2) voxels instead, which is more pixels there.
  const withinBound = ({ pixels, voxels }: { pixels: number; voxels: number }) =>
    pixels <= MAX_LEAK + step * focal || voxels <= TAN_HALF_FOV + step * DEPTH

  it('keeps every leak within max(max leak pixels, tan(fov / 2) voxels) with leakFreeDetail', () => {
    for (const { cells, cu, cz } of scenes) {
      expect(leaks(cells, cu, cz, detail).filter(l => !withinBound(l))).toEqual([])
    }
  })

  it('leaks more with 4x thicker slices', () => {
    const outside = scenes.flatMap(({ cells, cu, cz }) => leaks(cells, cu, cz, detail / 4).filter(l => !withinBound(l)))
    expect(outside.length).toBeGreaterThan(0)
  })
})
