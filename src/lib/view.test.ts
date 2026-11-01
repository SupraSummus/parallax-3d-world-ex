import { describe, it, expect } from 'vitest'
import { MAX_VIEW_TANGENT, projector, rectangleTest, screenRay, turn, viewBasis, viewTangents, type View } from './view'
import type { Vec3 } from './world'

/** Seeded uniform samples in [lo, hi), so failures reproduce. */
function sampler(seed: number) {
  let state = seed
  return (lo: number, hi: number) => {
    state = (state * 1103515245 + 12345) % 2147483648
    return lo + ((hi - lo) * state) / 2147483648
  }
}

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z
const view = (yaw: number, pitch: number, focal = 400): View => ({ orientation: { yaw, pitch }, width: 800, height: 600, focal })

/** Largest tangent off +z of a ray on screen. */
function reach(v: View): number {
  const t = viewTangents(v)
  if (!t) return Infinity
  return Math.max(-t.minX, t.maxX, -t.minY, t.maxY)
}

describe('viewBasis', () => {
  it('is orthonormal, keeps right level, and turns right and up for positive yaw and pitch', () => {
    const random = sampler(1)
    for (let i = 0; i < 100; i++) {
      const yaw = random(-80, 80)
      const pitch = random(-80, 80)
      const { right, up, forward } = viewBasis({ yaw, pitch })
      for (const [a, b] of [[right, up], [up, forward], [forward, right]]) expect(dot(a, b)).toBeCloseTo(0)
      for (const v of [right, up, forward]) expect(dot(v, v)).toBeCloseTo(1)
      expect(right.y).toBe(0)
      expect(Math.sign(forward.x)).toBe(Math.sign(yaw))
      expect(Math.sign(forward.y)).toBe(Math.sign(pitch))
    }
  })
})

describe('projector', () => {
  it('inverts screenRay and puts the view direction at the centre', () => {
    const random = sampler(2)
    for (let i = 0; i < 100; i++) {
      const v = view(random(-30, 30), random(-30, 30))
      const [sx, sy] = [random(0, 800), random(0, 600)]
      const ray = screenRay(v, sx, sy)
      const d = random(0.5, 100)
      const p = projector(v)({ x: ray.x * d, y: ray.y * d, z: ray.z * d })
      expect(p?.x).toBeCloseTo(sx)
      expect(p?.y).toBeCloseTo(sy)
      const { forward } = viewBasis(v.orientation)
      expect(projector(v)(forward)).toEqual({ x: expect.closeTo(400) as number, y: expect.closeTo(300) as number })
    }
  })
})

describe('viewTangents', () => {
  it('bounds the tangents of every ray on screen', () => {
    const random = sampler(3)
    for (let i = 0; i < 100; i++) {
      const v = view(random(-20, 20), random(-20, 20))
      const t = viewTangents(v)
      if (!t) throw new Error('every ray points ahead')
      const ray = screenRay(v, random(0, 800), random(0, 600))
      expect(ray.x / ray.z).toBeGreaterThanOrEqual(t.minX - 1e-9)
      expect(ray.x / ray.z).toBeLessThanOrEqual(t.maxX + 1e-9)
      expect(ray.y / ray.z).toBeGreaterThanOrEqual(t.minY - 1e-9)
      expect(ray.y / ray.z).toBeLessThanOrEqual(t.maxY + 1e-9)
    }
  })

  it('is the screen edges over the focal length straight ahead', () => {
    expect(viewTangents(view(0, 0))).toEqual({ minX: -1, maxX: 1, minY: -0.75, maxY: 0.75 })
  })
})

describe('rectangleTest', () => {
  it('passes a rectangle around the view direction and fails one far to the side', () => {
    const onScreen = rectangleTest(view(10, -10))
    // The view direction meets z = 10 at about (1.76, -1.79).
    expect(onScreen(1, 2, -2, -1, 10)).toBe(true)
    expect(onScreen(-30, -20, -2, -1, 10)).toBe(false)
    expect(onScreen(1, 2, 20, 30, 10)).toBe(false)
  })
})

describe('turn', () => {
  it('turns exactly to a target in reach', () => {
    expect(turn(view(0, 0), { yaw: 10, pitch: -10 })).toEqual({ yaw: 10, pitch: -10 })
  })

  it('never leaves reach, and stops at its edge', () => {
    const random = sampler(4)
    for (let i = 0; i < 100; i++) {
      const v = view(0, 0, random(250, 1000))
      const target = { yaw: random(-90, 90), pitch: random(-90, 90) }
      const orientation = turn(v, target)
      const r = reach({ ...v, orientation })
      expect(r).toBeLessThanOrEqual(MAX_VIEW_TANGENT + 1e-6)
      if (orientation.yaw !== target.yaw || orientation.pitch !== target.pitch) expect(r).toBeGreaterThan(MAX_VIEW_TANGENT - 1e-3)
    }
  })

  it('still pitches while yaw is pushed against the edge', () => {
    const atEdge = turn(view(0, 0), { yaw: 90, pitch: 0 })
    const pitched = turn({ ...view(0, 0), orientation: atEdge }, { yaw: 90, pitch: 3 })
    expect(pitched.pitch).toBeGreaterThan(0)
  })
})
