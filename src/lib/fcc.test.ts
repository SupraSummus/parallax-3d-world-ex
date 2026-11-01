import { describe, it, expect } from 'vitest'
import { VOXEL_FACES } from './fcc'

type Triple = [number, number, number]
const dot = (a: Triple, b: Triple) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const minus = (a: Triple, b: Triple): Triple => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: Triple, b: Triple): Triple => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

/** Whether p is in the voxel around the origin: |px| + |py|, |py| + |pz| and |px| + |pz| ≤ 1. */
const inVoxel = ([x, y, z]: Triple) => Math.abs(x) + Math.abs(y) <= 1 + 1e-9 && Math.abs(y) + Math.abs(z) <= 1 + 1e-9 && Math.abs(x) + Math.abs(z) <= 1 + 1e-9

describe('VOXEL_FACES', () => {
  it('has one face towards each of the 12 nearest sites, √2 away', () => {
    const normals = VOXEL_FACES.map(f => f.normal.join())
    expect(new Set(normals).size).toBe(12)
    for (const { normal } of VOXEL_FACES) {
      expect(dot(normal, normal)).toBe(2)
      // A site: coordinates add up to an even number.
      expect(Math.abs(normal[0] + normal[1] + normal[2]) % 2).toBe(0)
    }
  })

  it('puts each face halfway to its neighbour, on the boundary of the voxel, as a rhombus', () => {
    for (const { normal, corners } of VOXEL_FACES) {
      for (const corner of corners) {
        // The plane halfway to the neighbour: normal · p = |normal|² / 2.
        expect(dot(normal, corner)).toBe(1)
        expect(inVoxel(corner)).toBe(true)
      }
      const sides = corners.map((c, i) => minus(corners[(i + 1) % 4], c))
      expect(new Set(sides.map(s => dot(s, s))).size).toBe(1)
    }
  })

  it('winds every face counter-clockwise seen from outside', () => {
    for (const { normal, corners } of VOXEL_FACES) {
      for (let i = 0; i < 4; i++) {
        const turn = cross(minus(corners[(i + 1) % 4], corners[i]), minus(corners[(i + 2) % 4], corners[(i + 1) % 4]))
        expect(dot(turn, normal)).toBeGreaterThan(0)
      }
    }
  })

  it('bounds a voxel of volume 2, so voxels fill space (half of the integer points are sites)', () => {
    // Volume from the faces: a pyramid from the site over each rhombus.
    const volume = VOXEL_FACES.reduce((sum, { corners: [a, b, c, d] }) =>
      sum + (dot(a, cross(b, c)) + dot(a, cross(c, d))) / 6, 0)
    expect(volume).toBeCloseTo(2)
  })
})
