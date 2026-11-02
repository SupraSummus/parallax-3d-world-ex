/**
 * The occlusion-leak bound, derived step by step and checked.
 *
 * Claim: with the slicing of slice-selection.ts, geometry that true
 * perspective hides never shows by more than ε screen pixels (ε = the
 * renderer's max leak), except closer than 2 · `detail` layer spacings,
 * where slices cannot be thinner than one layer of voxels (two layer
 * spacings: a voxel reaches a layer past its own, see fcc.ts) and the bound
 * is 2 · tan(fov/2) layer spacings.
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
 * Depths are in face coordinates (view.ts): layers are LAYER apart. A
 * slice is a slab of layers of whole cells (cells.ts, slice-selection.ts);
 * its sites span siteLayers from the slab's first layer, and its voxels reach a
 * layer past those, so it is s = thickness · LAYER thick.
 *
 * Notation, for one lateral axis (x and y are independent): the camera is
 * at lateral 0, depth 0 (so z is relative to it). A slice has its near
 * face at distance a, thickness s, and centre plane at distance D, the
 * plane its chunks are baked onto and drawn at. A chunk is baked along
 * direction τ_b (a tangent). focal is the focal length in pixels, ε the
 * leak tolerance in pixels, C = 16 (see chunkCell).
 */
import { describe, it, expect } from 'vitest'
import {
  selectSlices, leakFreeDetail, bakeAngleError, directionStep, chunkCell, nearestDirection, sliceCentre, thickness, siteLayers, holds,
  CHUNK_SPAN, MAX_LEVEL, type SliceId,
} from './slice-selection'
import { ChunkBaker, FACE } from './chunk-baker'
import { FACES, LAYER } from './view'
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

const C = CHUNK_SPAN
const EPSILON = 1e-9

/** A random slice: level, layer, no cutoff. */
const randomSlice = (r: (lo: number, hi: number) => number, from: number, to: number): SliceId =>
  ({ level: Math.floor(r(0, MAX_LEVEL + 1)), layer: Math.floor(r(from, to)), cutoff: Infinity })
/** The layer of a slice's voxels' near tips. */
const nearSide = ({ level, layer }: SliceId) => layer * 2 ** level + siteLayers(level)[0] - 1

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
      const slice = randomSlice(r, 1, 30)
      const cameraZ = r(-1, 0)
      // Relative to the camera.
      const D = sliceCentre(slice) - cameraZ
      const z = (nearSide(slice) + r(0, thickness(slice.level))) * LAYER - cameraZ
      return { D, z, tau: r(-1.5, 1.5), tauB: r(-1.5, 1.5) }
    }, ({ D, z, tau, tauB }) => {
      const x = tau * z
      // Baking (bake/src/slicing.rs) projects it along τ_b onto the centre plane.
      const baked = x - tauB * (z - D)
      const offWorld = (baked / D - tau) * D
      return Math.abs(offWorld - (tau - tauB) * (z - D)) < 1e-6
    })
  })
})

describe('Step 2: within a slice |z − D| ≤ s/2', () => {
  /*
   * A voxel in layer c reaches from layer c − 1 to c + 1, so a slice whose
   * sites are in layers [l + lo, l + hi] (siteLayers, l its slab's first layer)
   * spans [l + lo − 1, l + hi + 1], s = thickness · LAYER thick, and
   * sliceCentre is its middle. With step 1, every point of a slice is drawn
   * at most |τ − τ_b|·s/2 from where it belongs.
   */
  it('holds for every point of the voxels of random slices', () => {
    forAll(2000, r => {
      const slice = randomSlice(r, -10, 10)
      const n = 2 ** slice.level
      // A site near the slab, kept if the slice holds it.
      const c = slice.layer * n + Math.floor(r(-n, 2 * n))
      const site: [number, number, number] = [2 * Math.floor(r(-n, n)) + (c & 1), 2 * Math.floor(r(-n, n)) + (c & 1), c]
      return { slice, site, z: (site[2] + r(-1, 1)) * LAYER }
    }, ({ slice, site, z }) => {
      if (!holds(slice, site)) return true
      return Math.abs(z - sliceCentre(slice)) <= (thickness(slice.level) / 2) * LAYER + EPSILON
    })
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
   * keeps thickness ≤ max(2, a / detail), in layers, a measured to the
   * slice's near side (single layers, level 0, are 2 thick).
   */
  it('selectSlices keeps every slice at most max(2, a / detail) thick', () => {
    forAll(300, r => ({ cameraZ: r(-300, 300), detail: 2 ** r(0, 8), range: r(10, 1000) }), ({ cameraZ, detail, range }) =>
      selectSlices(cameraZ, 2, range, detail).every(s => {
        const a = nearSide(s) - cameraZ
        return thickness(s.level) <= Math.max(2, a / detail) && sliceCentre(s) / LAYER - cameraZ >= a
      }))
  })
})

describe('Step 5: rays through a chunk are within C / (2·detail) of its centre ray', () => {
  /*
   * A chunk of a slice is C · 2^level layer spacings wide and 1/√2 of that
   * high (chunkCell), less than C · thickness, on the plane at distance D ≥ a, so
   * its rays span at most C · thickness · LAYER / D in tangent, at most
   * C / detail when thickness ≤ a / detail (step 4). The renderer only
   * shows what lands inside the chunk's cell, so no ray is further than
   * half that from the ray through the cell's centre.
   */
  it('holds for the chunks of random slicings', () => {
    forAll(300, r => ({ cameraZ: r(-300, 300), detail: 2 ** r(0, 8) }), ({ cameraZ, detail }) =>
      selectSlices(cameraZ, 2, 1000, detail)
        .filter(s => thickness(s.level) <= (nearSide(s) - cameraZ) / detail)
        .every(s => {
          const { width, height } = chunkCell(s.level, 0, 0)
          return Math.max(width, height) / 2 / (sliceCentre(s) - cameraZ * LAYER) <= C / (2 * detail) + EPSILON
        }))
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
   * Closer than 2 · `detail` layer spacings, a / detail < 2 but slices are
   * at least one layer (two spacings) thick, so step 4's bound becomes
   * τ_err · 2 layer spacings: at most 2 · tan(fov/2) spacings.
   */
  const leakBound = (focal: number, tan: number, detail: number) =>
    (Math.min(tan, C / detail) * focal) / detail

  it('keeps the bound within ε for random settings', () => {
    forAll(5000, r => ({ focal: 2 ** r(4, 12), tan: r(0.05, 2), epsilon: r(0.5, 64) }), ({ focal, tan, epsilon }) => {
      const detail = leakFreeDetail(focal, tan, epsilon)
      return detail === 1 || leakBound(focal, tan, detail) <= epsilon + EPSILON
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
    expect(leakBound(focal, 1, detail)).toBeGreaterThan(16)
  })
})

/**
 * Step 8 (end to end): the renderer against true perspective, in 2D, in the
 * plane b = 0 of a face's lattice (see Face in view.ts): lateral a and
 * depth c, voxels (a, 0, c) with a and c even. The plane cuts each into the
 * square |Δa|, |Δc| ≤ 1 (in lattice units; a and c are both LAYER per
 * unit, so tangents are the same as in face coordinates), and these tile
 * it. Slices, chunks, directions and faces come from the renderer's own
 * functions; only the clipping to cells and the compositing are restated
 * here, along the line b = 0 of each chunk. A leak is a run of screen where
 * the renderer shows a voxel that no perspective ray reaches, measured in
 * pixels of a SCREEN-pixel screen.
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
  const face = FACES[0]

  /** Deterministic heightfield with steps and cliffs, solid down to u = -12. */
  function terrain(seed: number): Cell[] {
    let state = seed
    const random = () => {
      state = (state * 1103515245 + 12345) % 2147483648
      return state / 2147483648
    }
    const cells: Cell[] = []
    let height = 0
    for (let z = 2; z < DEPTH; z += 2) {
      height += 2 * (random() < 0.7 ? Math.round(random() * 2 - 1) : Math.round(random() * 4 - 2))
      height = Math.max(-12, Math.min(12, height))
      for (let u = -12; u <= height; u += 2) cells.push({ u, z })
    }
    return cells
  }

  function perspectiveVisible(cells: Cell[], cu: number, cz: number): Set<number> {
    const nearest = rays.map(() => ({ distance: Infinity, cell: -1 }))
    cells.forEach(({ u, z }, cell) => {
      // The ray (cu + t·d, cz + d) is in the cell while |cz + d − z| ≤ 1 and |cu + t·d − u| ≤ 1.
      rays.forEach((t, i) => {
        let enter = Math.max(0, z - 1 - cz)
        let exit = z + 1 - cz
        if (t === 0) {
          if (Math.abs(cu - u) > 1) return
        } else {
          const [d0, d1] = [(u - 1 - cu) / t, (u + 1 - cu) / t]
          enter = Math.max(enter, Math.min(d0, d1))
          exit = Math.min(exit, Math.max(d0, d1))
        }
        if (enter <= exit && enter < nearest[i].distance) nearest[i] = { distance: enter, cell }
      })
    })
    return new Set(nearest.map(n => n.cell))
  }

  /** Where a convex polygon (x, y pairs) meets the line y = 0: [from, to], or null. */
  function onAxis(points: ArrayLike<number>): [number, number] | null {
    let from = Infinity
    let to = -Infinity
    for (let i = 0; i < 4; i++) {
      const [px, py, qx, qy] = [points[2 * i], points[2 * i + 1], points[(2 * i + 2) % 8], points[(2 * i + 3) % 8]]
      if (py === 0) [from, to] = [Math.min(from, px), Math.max(to, px)]
      if ((py < 0) !== (qy < 0) && py !== qy) {
        const x = px + ((qx - px) * -py) / (qy - py)
        ;[from, to] = [Math.min(from, x), Math.max(to, x)]
      }
    }
    return from < to ? [from, to] : null
  }

  /** dirStep 0 bakes every chunk straight along the face's axis. */
  function parallaxOwners(cells: Cell[], cu: number, cz: number, slices: SliceId[], dirStep: number): number[] {
    // The renderer's own face logic, on voxels (u, 0, z) of the face's lattice.
    const { right: R, forward: F } = face.lattice
    const baker = new ChunkBaker(VoxelGrid.fromVoxels(cells.map(({ u, z }) => ({
      x: (u * R.x + z * F.x) / 2, y: (u * R.y + z * F.y) / 2, z: (u * R.z + z * F.z) / 2, color: '#808080', type: 3,
    }))))
    const cellAt = new Map(cells.map(({ u, z }, cell) => [`${String(u)},${String(z)}`, cell]))
    const owner = rays.map(() => -1)
    for (const slice of [...slices].reverse()) {
      const centre = sliceCentre(slice)
      const distance = centre - cz * LAYER
      // Bricks of row 0, which holds b = 0: brick i spans [x + i · w, x + (i + 1) · w).
      const { x, width: w } = chunkCell(slice.level, 0, 0)
      const inSlice = ({ u, z }: Cell) => holds(slice, [u, 0, z])
      const chunkCells = new Set(cells.filter(inSlice).flatMap(({ u }) => {
        const i = Math.floor((u * LAYER - x) / w)
        return [i - 1, i, i + 1]
      }))
      for (const i of chunkCells) {
        const tan = dirStep === 0 ? 0 : Math.max(-1, Math.min(1, nearestDirection((x + (i + 0.5) * w - cu * LAYER) / distance, dirStep)))
        const data = baker.faces({ face: face.name, ...slice, i, j: 0, tanX: tan, tanY: 0, fillDetail: 0 })
        for (let f = 0; f < data.length / FACE; f++) {
          if (data[f * FACE + 9] === 0) continue
          const extent = onAxis(data.subarray(f * FACE, f * FACE + 8))
          if (!extent) continue
          const voxel = cellAt.get(`${String(data[f * FACE + 14])},${String(data[f * FACE + 16])}`) ?? -1
          // Clipped to the chunk's cell, then drawn at the centre plane's distance.
          const from = Math.max(x + i * w, extent[0])
          const to = Math.min(x + (i + 1) * w, extent[1])
          const first = Math.ceil(((from - cu * LAYER) / distance + TAN_HALF_FOV) / step)
          const last = Math.floor(((to - cu * LAYER) / distance + TAN_HALF_FOV) / step)
          for (let k = Math.max(0, first); k <= Math.min(RAYS - 1, last); k++) owner[k] = voxel
        }
      }
    }
    return owner
  }

  /** Every leak: its width in screen pixels and in lattice units at its nearest leaked voxel. */
  function leaks(cells: Cell[], cu: number, cz: number, detail: number, straight = false): { pixels: number; units: number }[] {
    const visible = perspectiveVisible(cells, cu, cz)
    const owner = parallaxOwners(cells, cu, cz, selectSlices(cz, 2, DEPTH, detail), straight ? 0 : directionStep(detail))
    const runs: { rays: number; distance: number }[] = []
    let run: { rays: number; distance: number } | null = null
    for (const cell of owner) {
      if (cell >= 0 && !visible.has(cell)) {
        run ??= { rays: 0, distance: Infinity }
        run.rays++
        run.distance = Math.min(run.distance, cells[cell].z - 1 - cz)
      } else if (run) {
        runs.push(run)
        run = null
      }
    }
    if (run) runs.push(run)
    return runs.map(r => ({ pixels: r.rays * step * focal, units: r.rays * step * r.distance }))
  }

  // Camera above the terrain looking over it, like the lake world.
  const scenes = [1, 2, 3, 4].map(seed => ({ cells: terrain(seed), cu: 12 + seed * 7.4, cz: -0.2 - seed * 0.4 }))
  const detail = leakFreeDetail(focal, TAN_HALF_FOV, MAX_LEAK)
  // Within the leak bound, give or take one ray. Slices are at least one
  // layer (two spacings) thick, so near the camera (closer than 2 · detail)
  // the bound is 2 · tan(fov / 2) units instead, which is more pixels there.
  const withinBound = ({ pixels, units }: { pixels: number; units: number }) =>
    pixels <= MAX_LEAK + step * focal || units <= 2 * TAN_HALF_FOV + step * DEPTH

  it('keeps every leak within max(max leak pixels, 2 · tan(fov / 2) units) with leakFreeDetail', () => {
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
      const widest = (straight: boolean) => Math.max(...[120, 200].flatMap(cu => [5, 6].flatMap(seed =>
        leaks(terrain(seed), cu, -0.6, detail, straight)
          .filter(l => l.units > 2 * TAN_HALF_FOV + step * DEPTH)
          .map(l => l.pixels))))
      expect(widest(false)).toBeLessThan(widest(true) * 0.7)
    })
  }
})
