/**
 * The occlusion-leak bound, derived step by step and checked.
 *
 * Claim: with the slicing of slice-selection.ts, geometry that true
 * perspective hides never shows by more than ε screen pixels (ε = the
 * renderer's max leak), except closer than `detail`, where slices cannot be
 * thinner than one voxel and the bound is tan(fov/2) voxels.
 *
 * Each `describe` below is one step: the claim in words, then a check on
 * random samples (seeded, so failures reproduce) using the same functions
 * the renderer uses. Steps 1, 2 and 4–7 are exact geometry and algebra.
 * Step 3 is the one modelling assumption: that a leak is at most the error
 * of the occluding edge plus that of the hidden one. It holds for single
 * intervals; for real scenes (several occluders, faces seen edge-on, the
 * cross-section of a cut slab) step 8 checks the whole chain against
 * ray-cast perspective. Where a step's check could pass vacuously, a
 * deliberately wrong variant is shown to fail.
 *
 * Each of these plausible mistakes in slice-selection.ts fails the step in
 * brackets (checked by hand when this file was written): centre plane at
 * depth + s/2 [2], baking with the wrong sign [1, 8], directions spaced by
 * more than C / detail [6] or rounded down [6], detail rounded down [7],
 * slice thickness measured from the centre instead of the near face [4],
 * an angle error that ignores the chunk width [7, 8].
 *
 * Notation, for one lateral axis (x and y are independent): the camera is
 * at lateral 0, depth 0 (so world z is relative to it). A slice has its
 * near face at distance a, thickness s, and centre plane at distance D, the
 * plane its chunks are baked onto and drawn at. A chunk is baked along
 * direction τ_b (a tangent). focal is the focal length in pixels, ε the
 * leak tolerance in pixels, C = chunkWidth(1).
 */
import { describe, it, expect } from 'vitest'
import {
  selectSlices, leakFreeDetail, bakeAngleError, directionStep, chunkWidth, nearestDirection, sliceCentre, bake,
  type SliceBoundary,
} from './slice-selection'
import { sliceSurface, chunkFaces, FACE, RECORD } from './bake'
import { VoxelGrid } from './voxel-grid'

/** Seeded uniform samples in [lo, hi). */
function sampler(seed: number) {
  let state = seed
  return (lo: number, hi: number) => {
    state = (state * 1103515245 + 12345) % 2147483648
    return lo + ((hi - lo) * state) / 2147483648
  }
}

/** Runs `check` on `n` random cases; fails with the first counterexample. */
function forAll<T>(n: number, generate: (random: (lo: number, hi: number) => number) => T, check: (c: T) => boolean) {
  const random = sampler(n * 7919 + 1)
  for (let i = 0; i < n; i++) {
    const c = generate(random)
    if (!check(c)) expect.fail(`counterexample: ${JSON.stringify(c)}`)
  }
}

const C = chunkWidth(1)
const EPSILON = 1e-9

describe('Step 1: a baked, drawn point is off by (τ − τ_b)·(z − D)', () => {
  /*
   * A point at lateral x, depth z is seen along tangent τ = x / z. Baking
   * along τ_b moves it to x' = x − τ_b·(z − D) on the centre plane, which
   * is drawn at distance D, i.e. at tangent x' / D. Writing x = τ·z and
   * z = D + δ: x' / D = τ + (τ − τ_b)·δ / D. So in world units at the
   * plane (tangent error × D) the point is off by (τ − τ_b)·(z − D).
   */
  it('holds for random points, slices and directions', () => {
    forAll(2000, r => {
      const slice: SliceBoundary = { depth: Math.floor(r(1, 300)), size: 2 ** Math.floor(r(0, 7)) }
      const cameraZ = r(-1, 0)
      // Relative to the camera.
      const D = sliceCentre(slice) - cameraZ
      const z = slice.depth - 0.5 + r(0, slice.size) - cameraZ
      return { D, z, tau: r(-1.5, 1.5), tauB: r(-1.5, 1.5) }
    }, ({ D, z, tau, tauB }) => {
      const x = tau * z
      const [baked] = bake(x, 0, z, tauB, 0, D)
      const offWorld = (baked / D - tau) * D
      return Math.abs(offWorld - (tau - tauB) * (z - D)) < 1e-6
    })
  })
})

describe('Step 2: within a slice |z − D| ≤ s/2', () => {
  /*
   * Voxels are unit cubes centred on integer z, so a slice holding z in
   * [depth, depth + s) spans [depth − 0.5, depth + s − 0.5], and
   * sliceCentre is its middle. With step 1, every point of a slice is drawn
   * at most |τ − τ_b|·s/2 from where it belongs.
   */
  it('holds for every point of random slices', () => {
    forAll(2000, r => {
      const slice: SliceBoundary = { depth: Math.floor(r(-300, 300)), size: 2 ** Math.floor(r(0, 7)) }
      return { slice, z: slice.depth - 0.5 + r(0, slice.size) }
    }, ({ slice, z }) => Math.abs(z - sliceCentre(slice)) <= slice.size / 2)
  })
})

describe('Step 3 (assumption): a leak is at most the sum of two edge errors', () => {
  /*
   * In perspective, a hidden interval B lies inside an occluding interval O
   * (for one occluder). Drawn, each end of O moves by at most e_O and each
   * end of B by at most e_B, so at most e_O + e_B of B shows past O on
   * either side. With step 2 both are τ_err·s/2, so a leak is at most
   * τ_err·s world units at the slice. Several occluders, faces seen
   * edge-on and the cut faces of slabs are what step 8 checks.
   */
  it('holds for random nested intervals and displacements', () => {
    forAll(5000, r => {
      const o0 = r(-10, 0)
      const o1 = r(0, 10)
      const b0 = r(o0, 0)
      const b1 = r(0, o1)
      const eO = r(0, 2)
      const eB = r(0, 2)
      return { o: [o0 + r(-eO, eO), o1 + r(-eO, eO)], b: [b0 + r(-eB, eB), b1 + r(-eB, eB)], eO, eB }
    }, ({ o, b, eO, eB }) => {
      const shownLeft = Math.max(0, Math.min(b[1], o[0]) - b[0])
      const shownRight = Math.max(0, b[1] - Math.max(b[0], o[1]))
      return Math.max(shownLeft, shownRight) <= eO + eB + EPSILON
    })
  })
})

describe('Step 4: in pixels, a leak is at most τ_err·focal / detail', () => {
  /*
   * A leak of w world units on a plane at distance D ≥ a is w·focal/D ≤
   * w·focal/a pixels. With step 3, w ≤ τ_err·s. Slices are at most
   * a / detail thick (or one voxel, see step 7), so the leak is at most
   * τ_err·s·focal/a ≤ τ_err·focal/detail pixels. This checks the slicing
   * keeps s ≤ max(1, a / detail).
   */
  it('selectSlices keeps every slice at most max(1, a / detail) thick', () => {
    forAll(300, r => ({ cameraZ: r(-300, 300), detail: 2 ** r(0, 8), range: r(10, 1000) }), ({ cameraZ, detail, range }) =>
      selectSlices(cameraZ, 1, range, detail).every(s => {
        const a = s.depth - 0.5 - cameraZ
        return s.size <= Math.max(1, a / detail) && sliceCentre(s) - cameraZ >= a
      }))
  })
})

describe('Step 5: rays through a chunk are within C / (2·detail) of its centre ray', () => {
  /*
   * A chunk of a size-s slice is chunkWidth(s) = C·s wide on the plane at
   * distance D ≥ a, so its rays span C·s / D in tangent, at most C·s / a
   * ≤ C / detail when s ≤ a / detail (step 4). The renderer only shows
   * what lands inside the chunk's cell, so no ray is further than half
   * that from the ray through the cell's centre.
   */
  it('holds for the chunks of random slicings', () => {
    forAll(300, r => ({ cameraZ: r(-300, 300), detail: 2 ** r(0, 8) }), ({ cameraZ, detail }) =>
      selectSlices(cameraZ, 1, 1000, detail)
        .filter(s => s.size <= (s.depth - 0.5 - cameraZ) / detail)
        .every(s => chunkWidth(s.size) / 2 / (sliceCentre(s) - cameraZ) <= C / (2 * detail) + EPSILON))
  })
})

describe('Step 6: τ_err ≤ C / detail', () => {
  /*
   * A chunk is baked along the multiple of Δ = directionStep(detail)
   * nearest to its centre ray, so at most Δ/2 from it, and Δ ≤ C / detail.
   * With step 5, every ray through the chunk is within
   * C / (2·detail) + Δ/2 ≤ C / detail of the baking direction. (Also, on
   * screen no ray is more than tan(fov/2) from straight ahead.)
   */
  it('directions are at most Δ/2 off, with Δ ≤ C / detail', () => {
    forAll(5000, r => ({ detail: 2 ** r(-2, 10), tangent: r(-3, 3) }), ({ detail, tangent }) => {
      const step = directionStep(detail)
      return step <= C / detail && Math.abs(nearestDirection(tangent, step) - tangent) <= step / 2 + EPSILON
    })
  })
})

describe('Step 7: leakFreeDetail closes the loop', () => {
  /*
   * Steps 4 and 6: the leak is at most τ_err·focal/detail pixels with
   * τ_err ≤ min(tan(fov/2), C / detail). Setting τ_err = √(C·ε / focal)
   * (or tan(fov/2) if smaller) and detail = τ_err·focal/ε makes both
   * equalities; leakFreeDetail then rounds detail up, which only shrinks
   * min(tan, C/detail)·focal/detail. So the leak is at most ε pixels, for
   * every focal length, field of view and tolerance.
   *
   * Closer than `detail`, a / detail < 1 but slices are one voxel thick,
   * so step 4's bound becomes τ_err·1 world units: at most tan(fov/2)
   * voxels.
   */
  const leakBound = (focal: number, tan: number, epsilon: number, detail: number) =>
    (Math.min(tan, C / detail) * focal) / detail

  it('keeps the bound within ε for random settings', () => {
    forAll(5000, r => ({ focal: 2 ** r(4, 12), tan: r(0.05, 2), epsilon: r(0.5, 64) }), ({ focal, tan, epsilon }) => {
      const detail = leakFreeDetail(focal, tan, epsilon)
      return detail === 1 || leakBound(focal, tan, epsilon, detail) <= epsilon + EPSILON
    })
  })

  it('uses the angle error it was derived with', () => {
    forAll(1000, r => ({ focal: 2 ** r(4, 12), tan: r(0.05, 2), epsilon: r(0.5, 64) }), ({ focal, tan, epsilon }) => {
      const tauErr = bakeAngleError(focal, tan, epsilon)
      return tauErr <= tan && Math.abs(tauErr - Math.min(tan, Math.sqrt((C * epsilon) / focal))) < EPSILON
    })
  })

  it('half the detail would break it', () => {
    const focal = 640
    const detail = leakFreeDetail(focal, 1, 16) / 2
    expect(leakBound(focal, 1, 16, detail)).toBeGreaterThan(16)
  })
})

/**
 * Step 8 (end to end): the renderer against true perspective, in 2D: one
 * lateral axis u (think height) and depth z, voxels (u, 0, z). Slices,
 * chunks, directions and faces come from the renderer's own functions; only
 * the clipping to cells and the compositing are restated here. A leak is a
 * run of screen where the renderer shows a voxel that no perspective ray
 * reaches, measured in pixels of a SCREEN-pixel screen.
 */
describe.each([1, 0.5, 0.25])('Step 8: ray-cast leaks with tan(fov / 2) = %s', TAN_HALF_FOV => {
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
        let enter = z - 0.5 - cz
        let exit = z + 0.5 - cz
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

  /** dirStep 0 bakes every chunk straight along z. */
  function parallaxOwners(cells: Cell[], cu: number, cz: number, slices: SliceBoundary[], dirStep: number): number[] {
    // The renderer's own face logic, on voxels (u, 0, z).
    const grid = VoxelGrid.fromVoxels(cells.map(({ u, z }) => ({ x: u, y: 0, z, color: '#808080', type: 3 })))
    const cellAt = new Map(cells.map(({ u, z }, cell) => [`${String(u)},${String(z)}`, cell]))
    const owner = rays.map(() => -1)
    for (const slice of [...slices].reverse()) {
      const centre = sliceCentre(slice)
      const distance = centre - cz
      const w = chunkWidth(slice.size)
      const surface = sliceSurface(grid, slice.depth, slice.size)
      const chunkCells = new Set(cells.filter(({ z }) => z >= slice.depth && z < slice.depth + slice.size).flatMap(({ u }) => {
        const x0 = Math.floor(u / w) * w
        return [x0 - w, x0, x0 + w]
      }))
      for (const x0 of chunkCells) {
        const tan = dirStep === 0 ? 0 : nearestDirection((x0 + w / 2 - 0.5 - cu) / distance, dirStep)
        const { data, count } = chunkFaces(surface, x0, 0, tan, 0)
        for (let f = 0; f < count; f++) {
          const record = data[f * FACE + 9] * RECORD
          const cell = cellAt.get(`${String(surface.records[record])},${String(surface.records[record + 2])}`) ?? -1
          // Clipped to the chunk's cell, then drawn at the centre plane's distance.
          const xs = [0, 2, 4, 6].map(k => data[f * FACE + k])
          const from = Math.max(x0 - 0.5, Math.min(...xs))
          const to = Math.min(x0 + w - 0.5, Math.max(...xs))
          const first = Math.ceil(((from - cu) / distance + TAN_HALF_FOV) / step)
          const last = Math.floor(((to - cu) / distance + TAN_HALF_FOV) / step)
          for (let i = Math.max(0, first); i <= Math.min(RAYS - 1, last); i++) owner[i] = cell
        }
      }
    }
    return owner
  }

  /** Every leak: its width in screen pixels and in voxels at its nearest leaked voxel. */
  function leaks(cells: Cell[], cu: number, cz: number, detail: number, straight = false): { pixels: number; voxels: number }[] {
    const visible = perspectiveVisible(cells, cu, cz)
    const owner = parallaxOwners(cells, cu, cz, selectSlices(cz, 1, DEPTH, detail), straight ? 0 : directionStep(detail))
    const runs: { rays: number; distance: number }[] = []
    let run: { rays: number; distance: number } | null = null
    for (const cell of owner) {
      if (cell >= 0 && !visible.has(cell)) {
        run ??= { rays: 0, distance: Infinity }
        run.rays++
        run.distance = Math.min(run.distance, cells[cell].z - cz)
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
  const detail = leakFreeDetail(focal, TAN_HALF_FOV, MAX_LEAK)
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

  // Only where the baking directions are what allows the thinner detail.
  if (bakeAngleError(focal, TAN_HALF_FOV, MAX_LEAK) < TAN_HALF_FOV) {
    it('leaks less than baking every chunk straight, seen from high above', () => {
      const widest = (straight: boolean) => Math.max(...[60, 100].flatMap(cu => [5, 6].flatMap(seed =>
        leaks(terrain(seed), cu, -0.3, detail, straight)
          .filter(l => l.voxels > TAN_HALF_FOV + step * DEPTH)
          .map(l => l.pixels))))
      expect(widest(false)).toBeLessThan(widest(true) * 0.7)
    })
  }
})
