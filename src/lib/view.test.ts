import { describe, it, expect } from 'vitest'
import { FACES, faceTangents, projector, rectangleTest, screenRay, toLocal, viewBasis, type Face, type View } from './view'
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
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x })
const view = (yaw: number, pitch: number, focal = 400): View => ({ orientation: { yaw, pitch }, width: 800, height: 600, focal })
const face = (name: string) => FACES.find(f => f.name === name) as Face

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

describe('FACES', () => {
  // A mirrored face would draw its world mirrored.
  it('are rotations, one looking along each axis', () => {
    for (const { right, up, forward } of FACES) expect(dot(cross(right, up), forward)).toBe(1)
    const forwards = FACES.map(({ forward: { x, y, z } }) => `${String(x)},${String(y)},${String(z)}`)
    expect(new Set(forwards).size).toBe(6)
  })
})

describe('projector', () => {
  it('inverts screenRay on every face', () => {
    const random = sampler(2)
    for (let i = 0; i < 100; i++) {
      const v = view(random(-180, 180), random(-90, 90))
      const f = FACES[Math.floor(random(0, 6))]
      const [sx, sy] = [random(0, 800), random(0, 600)]
      const ray = screenRay(v, f, sx, sy)
      const d = random(0.5, 100)
      const p = projector(v, f)({ x: ray.x * d, y: ray.y * d, z: ray.z * d })
      expect(p?.x).toBeCloseTo(sx)
      expect(p?.y).toBeCloseTo(sy)
    }
  })
})

describe('faceTangents', () => {
  it('is the screen edges over the focal length straight ahead, and nothing of the other faces', () => {
    expect(faceTangents(view(0, 0), face('+z'))).toEqual({ minX: -1, maxX: 1, minY: -0.75, maxY: 0.75 })
    // ±x only touch the screen's side edges.
    for (const f of FACES.slice(1)) expect(faceTangents(view(0, 0), f)).toBeNull()
  })

  // Each ray belongs to the face of its largest component; that face must search where the ray lands.
  it('covers every ray on screen by the face it belongs to', () => {
    const random = sampler(3)
    for (let i = 0; i < 300; i++) {
      const v = view(random(-180, 180), random(-90, 90), random(150, 1000))
      const world = screenRay(v, FACES[0], random(0, 800), random(0, 600))
      const f = FACES.find(candidate => {
        const local = toLocal(candidate, world)
        return local.z >= Math.abs(local.x) && local.z >= Math.abs(local.y)
      }) as Face
      const ray = toLocal(f, world)
      const t = faceTangents(v, f)
      expect(t).not.toBeNull()
      if (!t) continue
      expect(ray.x / ray.z).toBeGreaterThanOrEqual(t.minX - 1e-9)
      expect(ray.x / ray.z).toBeLessThanOrEqual(t.maxX + 1e-9)
      expect(ray.y / ray.z).toBeGreaterThanOrEqual(t.minY - 1e-9)
      expect(ray.y / ray.z).toBeLessThanOrEqual(t.maxY + 1e-9)
    }
  })
})

describe('rectangleTest', () => {
  it('passes a rectangle around the view direction and fails one to the side or behind', () => {
    const onScreen = rectangleTest(view(10, -10), FACES[0])
    // The view direction meets z = 10 at about (1.76, -1.79).
    expect(onScreen(1, 2, -2, -1, 10)).toBe(true)
    expect(onScreen(-30, -20, -2, -1, 10)).toBe(false)
    expect(rectangleTest(view(180, 0), FACES[0])(1, 2, -2, -1, 10)).toBe(false)
  })

  it('passes a rectangle reaching from behind the camera into view', () => {
    // Looking along +x; the rectangle on z = 10 spans x from -50 to 50.
    expect(rectangleTest(view(90, 0), FACES[0])(-50, 50, -1, 1, 10)).toBe(true)
  })
})
