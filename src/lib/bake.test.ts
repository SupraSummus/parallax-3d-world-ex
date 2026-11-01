import { describe, it, expect } from 'vitest'
import { sliceSurface, shadedPalette, chunkFaces, fillFaces, faceShade, FACE, FACE_SHADE, RECORD, type ChunkFaces } from './bake'
import { VOXEL_FACES } from './fcc'
import { chunkWidth, sliceCentre } from './slice-selection'
import { FACES, toLocal, type Face } from './view'
import { VoxelGrid, isSite, type Voxel } from './voxel-grid'
import { World } from './world'

// Bits of a surface record's mask, as documented in bake.ts.
const ON_FAR = 1 << 12
const CUT = 16

/** World point of face coordinates (u, v, w). */
const toWorld = (face: Face, u: number, v: number, w: number) => ({
  x: u * face.right.x + v * face.up.x + w * face.forward.x,
  y: u * face.right.y + v * face.up.y + w * face.forward.y,
  z: u * face.right.z + v * face.up.z + w * face.forward.z,
})

describe('sliceSurface', () => {
  it('matches a brute-force scan: open and cut faces, grouped by cell, far to near', () => {
    const world = new World(7, 'hills_with_trees')
    for (const face of [FACES[0], FACES[4]]) {
      const has = (u: number, v: number, w: number) => { const p = toWorld(face, u, v, w); return world.has(p.x, p.y, p.z) }
      const local = world.voxels.map(v => toLocal(face, v))
      for (const [depth, size] of [[-80, 8], [-3, 1], [0, 32]]) {
        const expected = local.filter(({ z }) => z >= depth && z < depth + size).flatMap(({ x, y, z }) => {
          let mask = 0
          VOXEL_FACES.forEach(({ normal: [a, b, c] }, k) => {
            const neighbour = has(x + a, y + b, z + c)
            if (!neighbour) mask |= 1 << k
            // The near plane cuts the slice from its neighbours in the previous one.
            else if (c < 0 && z === depth) mask |= 1 << (CUT + k)
            else if (c > 0 && z === depth + size - 1) mask |= ON_FAR
          })
          return mask & ~ON_FAR ? [[x, y, z, mask].join()] : []
        })

        const surface = sliceSurface(world.grid, face, depth, size)
        const w = chunkWidth(size)
        const actual: string[] = []
        for (let k = 0; k < surface.cellsX * surface.cellsY; k++) {
          let lastZ = Infinity
          for (let r = surface.cellStart[k]; r < surface.cellStart[k + 1]; r++) {
            const [x, y, z, , mask] = surface.records.subarray(r * RECORD, (r + 1) * RECORD)
            expect((Math.floor(y / w) - surface.cellY) * surface.cellsX + Math.floor(x / w) - surface.cellX).toBe(k)
            expect(z).toBeLessThanOrEqual(lastZ)
            lastZ = z
            actual.push([x, y, z, mask].join())
          }
        }
        expect(actual.sort()).toEqual(expected.sort())
      }
    }
  }, 30_000)
})

describe('shadedPalette', () => {
  it('shades a face by the axes it faces along in the world', () => {
    const { front, back, left, right, bottom, top } = FACE_SHADE
    expect([[0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0]].map(([x, y, z]) => faceShade({ x, y, z })))
      .toEqual([front, back, left, right, bottom, top])
    expect(faceShade({ x: 0, y: 1, z: -1 })).toBeCloseTo((top + front) / 2)

    const white = [{ color: '#000000', type: 0 }, { color: '#ffffff', type: 1 }]
    const kind = (a: number, b: number, c: number) => VOXEL_FACES.findIndex(({ normal }) => normal.join() === [a, b, c].join())
    // A face's local (0, 1, -1) kind faces up and towards the camera, in the world:
    const expected: Record<string, number> = {
      '+z': (top + front) / 2, // up and -z
      '+x': (top + left) / 2, // up and -x
      '+y': (front + bottom) / 2, // -z (the face's up is -z) and -y
    }
    for (const face of FACES.filter(f => f.name in expected)) {
      const red = shadedPalette(white, face)[VOXEL_FACES.length + kind(0, 1, -1)] & 255
      expect(red).toBe(Math.round(255 * expected[face.name]))
    }
  })
})

/**
 * The colour (an index into shadedPalette) that the first voxel of a slice
 * hit by the ray (px, py, centre) + t · (tanX, tanY, 1) shows: the face it
 * enters through. Null if it hits nothing, or if rays a hair apart disagree
 * (an edge passes there).
 */
function rayCast(voxels: Voxel[], ids: Map<string, number>, centre: number, px: number, py: number, tanX: number, tanY: number): number | null {
  const one = (ox: number, oy: number) => {
    let best = { t: Infinity, colour: -1 }
    for (const v of voxels) {
      let enter = -Infinity
      let exit = Infinity
      let through = -1
      // Inside the voxel: n · (p − site) ≤ 1 for every face normal n.
      VOXEL_FACES.forEach(({ normal: [a, b, c] }, k) => {
        const nd = a * tanX + b * tanY + c
        const no = a * (ox - v.x) + b * (oy - v.y) + c * (centre - v.z)
        if (nd === 0) {
          if (no > 1) enter = Infinity
        } else if (nd < 0) {
          const t = (1 - no) / nd
          if (t > enter) [enter, through] = [t, k]
        } else {
          exit = Math.min(exit, (1 - no) / nd)
        }
      })
      if (enter < exit && enter < best.t) best = { t: enter, colour: (ids.get(v.color) ?? 0) * VOXEL_FACES.length + through }
    }
    return best.colour
  }
  const colours = [[0, 0], [0.01, 0.003], [-0.004, 0.01], [0.007, -0.009], [-0.01, -0.005]].map(([dx, dy]) => one(px + dx, py + dy))
  return colours.every(c => c === colours[0]) ? colours[0] : null
}

describe('chunkFaces and fillFaces', () => {
  // A seeded blob of voxels: solid at the bottom, sparse above.
  let state = 12345
  const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
  const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00']
  const voxels: Voxel[] = []
  for (let x = -6; x < 40; x++) {
    for (let y = -6; y < 40; y++) {
      for (let z = 0; z < 8; z++) {
        if (isSite(x, y, z) && (y < 4 || random() < 0.25)) voxels.push({ x, y, z, color: colors[Math.floor(random() * 4)], type: 1 })
      }
    }
  }
  const grid = VoxelGrid.fromVoxels(voxels)
  const ids = new Map(grid.materials.map((m, id) => [m.color, id]))

  // Slices starting above the blob's bottom show cut faces.
  it.each([
    [0, 1, 0, 0], [0, 2, 0.5, -0.25], [0, 2, -1, 1], [0, 4, 1, 0.75], [0, 8, 0.25, 1],
    [2, 1, 0.5, 0.5], [2, 4, -0.5, 0.5], [3, 2, 0, -1],
  ])('paints what a ray along the baking direction hits first (depth %s, size %s, tangents %s, %s)', (depth, size, tanX, tanY) => {
    const surface = sliceSurface(grid, FACES[0], depth, size)
    const centre = sliceCentre(surface)
    const inSlice = voxels.filter(v => v.z >= depth && v.z < depth + size)
    const w = chunkWidth(size)
    const scale = Math.max(1, 64 / w)
    const [x0, y0] = [0, 0]
    const faces = chunkFaces(surface, x0, y0, tanX, tanY)
    const side = w * scale
    const pixels = new Uint32Array(side * side)
    // The palette maps a colour index to itself (+ 1, so 0 stays empty).
    const palette = Uint32Array.from({ length: grid.materials.length * VOXEL_FACES.length }, (_, i) => i + 1)
    fillFaces(faces, palette, pixels, side, side, x0 - 0.5, y0 + w - 0.5, scale)

    let compared = 0
    const wrong: string[] = []
    // About 1000 samples: ray casting is slow.
    const step = side / 32
    for (let row = 0; row < side; row += step) {
      for (let col = 0; col < side; col += step) {
        const px = x0 - 0.5 + (col + 0.5) / scale
        const py = y0 + w - 0.5 - (row + 0.5) / scale
        const expected = rayCast(inSlice, ids, centre, px, py, tanX, tanY)
        if (expected === null) continue
        compared++
        if (pixels[row * side + col] !== expected + 1) wrong.push(`(${String(px)}, ${String(py)}): ${String(pixels[row * side + col] - 1)} ≠ ${String(expected)}`)
      }
    }
    // Faces seen edge-on (tangent ±1) leave many samples on an edge.
    expect(compared).toBeGreaterThan(300)
    expect(wrong).toEqual([])
  }, 30_000)

  it('grows only the open faces of voxels going on into the next slice', () => {
    // A floor two layers thick through slices [0, 4) and [4, 8), baked
    // straight along z, so its sides facing up show only grown.
    const floor = VoxelGrid.fromVoxels(voxels.filter(v => v.y >= 0 && v.y < 2))
    const surface = sliceSurface(floor, FACES[0], 0, 4)
    const { data, count } = chunkFaces(surface, 0, 0, 0, 0, 27)
    const grown = Array.from({ length: count }, (_, f) => f * FACE)
      .filter(o => data.subarray(o + 11, o + 15).some(g => g > 0))
      .map(o => {
        const record = data[o + 9] * RECORD
        const kind = data[o + 8] % VOXEL_FACES.length
        return { z: surface.records[record + 2], open: (surface.records[record + 4] & (1 << kind)) !== 0, reached: data[o + 10] }
      })
    expect(grown.length).toBeGreaterThan(0)
    expect(grown.every(({ z, open }) => open && z === 3)).toBe(true)
    expect(grown.some(({ reached }) => reached === 0)).toBe(true)
  })
})

describe('fillFaces', () => {
  /** Faces from corner lists: colour, reached, growth left, bottom, right, top. */
  const facesOf = (list: { corners: number[]; colour: number; reached?: boolean; grow?: number[] }[]): ChunkFaces => {
    const data = new Float64Array(list.length * FACE)
    list.forEach(({ corners, colour, reached = true, grow = [0, 0, 0, 0] }, f) => {
      data.set(corners, f * FACE)
      data[f * FACE + 8] = colour
      data[f * FACE + 9] = f
      data[f * FACE + 10] = reached ? 1 : 0
      data.set(grow, f * FACE + 11)
    })
    return { data, count: list.length, minX: 0, maxX: 0, minY: 0, maxY: 0 }
  }
  const palette = Uint32Array.from({ length: 16 }, (_, i) => i)
  const fill = (faces: ChunkFaces) => {
    const pixels = new Uint32Array(40 * 40)
    fillFaces(faces, palette, pixels, 40, 40, 0, 4, 10)
    return pixels
  }

  it('fills parallelograms sharing an edge without overlap or gaps', () => {
    // A parallelogram cut in two along a slanted line through it.
    const a = [0.13, 0.31, 1.7, 0.47, 2.11, 2.93, 0.54, 2.77]
    const left = [0.13, 0.31, 0.9, 0.39, 1.33, 2.85, 0.54, 2.77]
    const right = [0.9, 0.39, 1.7, 0.47, 2.11, 2.93, 1.33, 2.85]
    const whole = fill(facesOf([{ corners: a, colour: 1 }]))
    const l = fill(facesOf([{ corners: left, colour: 1 }]))
    const r = fill(facesOf([{ corners: right, colour: 1 }]))
    expect(whole.reduce((n, p) => n + p, 0)).toBeGreaterThan(300)
    expect(Array.from(whole)).toEqual(Array.from(l, (p, i) => p + r[i]))
  })

  it('grows a face into its outline swept over the growth rectangle', () => {
    // Pixel centre p is in the swept outline iff the rectangle
    // [p.x − right, p.x + left] × [p.y − top, p.y + bottom] meets the face:
    // no separating axis among the rectangle's and the face's sides.
    let state = 7
    const random = () => {
      state = (state * 1103515245 + 12345) % 2147483648
      return state / 2147483648
    }
    const meets = (corners: number[], x0: number, x1: number, y0: number, y1: number) => {
      const rect = [x0, y0, x1, y0, x1, y1, x0, y1]
      const axes = [[1, 0], [0, 1], ...[0, 1].map(i => [corners[2 * i + 3] - corners[2 * i + 1], corners[2 * i] - corners[2 * i + 2]])]
      return axes.every(([ax, ay]) => {
        const project = (points: number[]) => points.filter((_, i) => i % 2 === 0).map((x, i) => x * ax + points[2 * i + 1] * ay)
        const [p, q] = [project(corners), project(rect)]
        return Math.max(...p) >= Math.min(...q) && Math.max(...q) >= Math.min(...p)
      })
    }
    let painted = 0
    for (let n = 0; n < 200; n++) {
      const [ox, oy, ax, ay, bx, by] = [random() * 2 + 1, random() * 2 + 1, random() * 2 - 1, random() * 2 - 1, random() * 2 - 1, random() * 2 - 1]
      const corners = [ox, oy, ox + ax, oy + ay, ox + ax + bx, oy + ay + by, ox + bx, oy + by]
      // Some sides not grown at all.
      const grow = [0, 0, 0, 0].map(() => (random() < 0.3 ? 0 : random()))
      const pixels = fill(facesOf([{ corners, colour: 1, reached: false, grow }]))
      const [left, bottom, right, top] = grow
      for (let row = 0; row < 40; row++) {
        for (let col = 0; col < 40; col++) {
          const [x, y] = [(col + 0.5) / 10, 4 - (row + 0.5) / 10]
          expect(pixels[row * 40 + col] === 1).toBe(meets(corners, x - right, x + left, y - top, y + bottom))
          painted += pixels[row * 40 + col]
        }
      }
    }
    expect(painted).toBeGreaterThan(10_000)
  })

  it('paints reached faces in order, then grows every face only into empty pixels', () => {
    const square = (x: number, y: number, s: number) => [x, y, x + s, y, x + s, y + s, x, y + s]
    const pixels = fill(facesOf([
      { corners: square(0, 0, 2), colour: 0xa, grow: [0, 0, 1, 1] }, // grown right and up
      { corners: square(1, 0, 2), colour: 0xb }, // painted over 0xa
      { corners: square(3, 3, 0.5), colour: 0xc, reached: false }, // not reached: painted only where empty
    ]))
    const at = (x: number, y: number) => pixels[Math.floor((4 - y) * 10) * 40 + Math.floor(x * 10)]
    // 0xc is nearer than 0xa's growth, so it is painted first.
    expect([at(0.5, 0.5), at(1.5, 0.5), at(2.5, 1.5), at(0.5, 2.5), at(3.2, 3.2), at(3.8, 3.8)]).toEqual([0xa, 0xb, 0xb, 0xa, 0xc, 0])
  })
})
