import { describe, it, expect } from 'vitest'
import { cellSurface, shadedPalette, chunkFaces, fillFaces, faceShade, FACE, FACE_SHADE, RECORD, type ChunkFaces } from './bake'
import { VOXEL_FACES } from './fcc'
import { chunkCell, sliceCentre } from './slice-selection'
import { FACES, LAYER, toLocal, type Face } from './view'
import { VoxelGrid, type Voxel } from './voxel-grid'
import { World, type Vec3 } from './world'

// Bits of a surface record's mask, as documented in bake.ts.
const ON_FAR = 1 << 12
const CUT = 16

const dot = (p: Vec3, v: Vec3) => p.x * v.x + p.y * v.y + p.z * v.z
/** A world point's lattice coordinates on a face (see Face in view.ts). */
const toLattice = ({ lattice: { right, up, forward } }: Face, p: Vec3) => ({ a: dot(p, right), b: dot(p, up), c: dot(p, forward) })
/** The world point at lattice coordinates (a, b, c) of a face. */
const toWorld = ({ lattice: { right: R, up: U, forward: F } }: Face, a: number, b: number, c: number): Vec3 => ({
  x: (a * R.x + c * F.x) / 2 + b * U.x,
  y: (a * R.y + c * F.y) / 2 + b * U.y,
  z: (a * R.z + c * F.z) / 2 + b * U.z,
})
// Face kinds as bake.ts numbers them: VOXEL_FACES in the lattice coordinates of any face.
const kindOffsets = VOXEL_FACES.map(({ normal: [x, y, z] }) => toLattice(FACES[0], { x, y, z }))

describe('cellSurface', () => {
  it('matches a brute-force scan: open and cut faces, cell by cell, far to near', () => {
    const world = new World(7, 'hills_with_trees')
    for (const face of [FACES[0], FACES[4], FACES[8]]) {
      const has = (a: number, b: number, c: number) => { const p = toWorld(face, a, b, c); return world.has(p.x, p.y, p.z) }
      const local = world.voxels.map(v => toLattice(face, v))
      for (const [depth, size] of [[-80, 8], [-3, 1], [0, 32]]) {
        const expected = local.filter(({ c }) => c >= depth && c < depth + size).flatMap(({ a, b, c }) => {
          let mask = 0
          kindOffsets.forEach(({ a: da, b: db, c: dc }, k) => {
            if (!has(a + da, b + db, c + dc)) mask |= 1 << k
            // The near plane cuts the slice from its neighbours in the previous one.
            else if (c + dc < depth) mask |= 1 << (CUT + k)
            else if (c + dc >= depth + size) mask |= ON_FAR
          })
          return mask & ~ON_FAR ? [[a, b, c, mask].join()] : []
        })
        expect(expected.length).toBeGreaterThan(0)

        // Each cell's surface holds its own voxels and some around it.
        const { columns, rows } = chunkCell(size)
        const cells = new Set(local.map(({ a, b }) => [Math.floor(a / columns), Math.floor(b / rows)].join()))
        const actual = new Set<string>()
        for (const [i, j] of [...cells].map(k => k.split(',').map(Number))) {
          const records = cellSurface(world.grid, face.lattice, depth, size, i, j)
          let lastC = Infinity
          for (let r = 0; r < records.length; r += RECORD) {
            const [a, b, c, , mask] = records.subarray(r, r + RECORD)
            expect(c).toBeLessThanOrEqual(lastC)
            lastC = c
            actual.add([a, b, c, mask].join())
          }
        }
        expect([...actual].sort()).toEqual(expected.sort())
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
    const kind = (a: number, b: number, c: number) => kindOffsets.findIndex(o => o.a === a && o.b === b && o.c === c)
    // Seen along +x+z (up is +y, right is (1, 0, -1) / √2): the front kind
    // faces -x and -z; the kind a step up, right and towards the camera faces up and -z.
    const palette = shadedPalette(white, (FACES.find(f => f.name === '+x+z') as Face).lattice)
    const red = (k: number) => palette[VOXEL_FACES.length + k] & 255
    expect(red(kind(0, 0, -2))).toBe(Math.round(255 * (left + front) / 2))
    expect(red(kind(1, 1, -1))).toBe(Math.round(255 * (top + front) / 2))
  })
})

/**
 * The colour (an index into shadedPalette) that the first voxel of a slice
 * hit by the ray (px, py, centre) + t · (tanX, tanY, 1) shows: the face it
 * enters through. All in face coordinates. Null if it hits nothing, or if
 * rays a hair apart disagree (an edge passes there).
 */
function rayCast(sites: (Vec3 & { id: number })[], centre: number, px: number, py: number, tanX: number, tanY: number): number | null {
  // Kinds' normals in face coordinates, the same on every face.
  const normals = VOXEL_FACES.map(({ normal: [x, y, z] }) => toLocal(FACES[0], { x, y, z }))
  const one = (ox: number, oy: number) => {
    let best = { t: Infinity, colour: -1 }
    for (const v of sites) {
      let enter = -Infinity
      let exit = Infinity
      let through = -1
      // Inside the voxel: n · (p − site) ≤ 1 for every face normal n.
      normals.forEach(({ x: a, y: b, z: c }, k) => {
        const nd = a * tanX + b * tanY + c
        const no = a * (ox - v.x) + b * (oy - v.y) + c * (centre - v.z)
        if (Math.abs(nd) < 1e-12) {
          if (no > 1) enter = Infinity
        } else if (nd < 0) {
          const t = (1 - no) / nd
          if (t > enter) [enter, through] = [t, k]
        } else {
          exit = Math.min(exit, (1 - no) / nd)
        }
      })
      if (enter < exit && enter < best.t) best = { t: enter, colour: v.id * VOXEL_FACES.length + through }
    }
    return best.colour
  }
  const colours = [[0, 0], [0.01, 0.003], [-0.004, 0.01], [0.007, -0.009], [-0.01, -0.005]].map(([dx, dy]) => one(px + dx, py + dy))
  return colours.every(c => c === colours[0]) ? colours[0] : null
}

describe('chunkFaces and fillFaces', () => {
  // A seeded blob of voxels in the lattice of a face: solid at the bottom
  // (b), sparse above, in layers 0 to 7.
  let state = 12345
  const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
  const face = FACES[0]
  const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00']
  const voxels: (Voxel & { a: number; b: number; c: number })[] = []
  for (let c = 0; c < 8; c++) {
    for (let b = -6 + ((c + 6) & 1); b < 30; b += 2) {
      for (let a = -6 + ((c + 6) & 1); a < 40; a += 2) {
        if (b < 4 || random() < 0.25) voxels.push({ ...toWorld(face, a, b, c), a, b, c, color: colors[Math.floor(random() * 4)], type: 1 })
      }
    }
  }
  const grid = VoxelGrid.fromVoxels(voxels)
  const ids = new Map(grid.materials.map((m, id) => [m.color, id]))

  // Slices starting above the blob's bottom show cut faces. Directions
  // within the face's rhombus, some on its edge.
  it.each([
    [0, 1, 0, 0], [0, 2, 0.5, -0.25], [0, 2, -1, 0], [0, 4, 0.25, 0.5], [0, 8, 0.5, 0.25],
    [2, 1, 0.5, 0.35], [2, 4, -0.5, -0.35], [3, 2, 0, -LAYER],
  ])('paints what a ray along the baking direction hits first (depth %s, size %s, tangents %s, %s)', (depth, size, tanX, tanY) => {
    const centre = sliceCentre({ depth, size })
    const sites = voxels.filter(v => v.c >= depth && v.c < depth + size)
      .map(v => ({ x: v.a * LAYER, y: v.b, z: v.c * LAYER, id: ids.get(v.color) ?? 0 }))
    const { width: w, height: h } = chunkCell(size)
    const scale = Math.max(1, 64 / h)
    const faces = chunkFaces({ depth, size }, cellSurface(grid, face.lattice, depth, size, 0, 0), 0, 0, tanX, tanY)
    const [cols, rows] = [Math.ceil(w * scale), Math.ceil(h * scale)]
    const pixels = new Uint32Array(cols * rows)
    // The palette maps a colour index to itself (+ 1, so 0 stays empty).
    const palette = Uint32Array.from({ length: grid.materials.length * VOXEL_FACES.length }, (_, i) => i + 1)
    fillFaces(faces, palette, pixels, cols, rows, 0, h, scale)

    let compared = 0
    const wrong: string[] = []
    // About 1000 samples: ray casting is slow.
    for (let row = 0; row < rows; row += rows / 24) {
      for (let col = 0; col < cols; col += cols / 36) {
        const [i, j] = [Math.floor(col), Math.floor(row)]
        const px = (i + 0.5) / scale
        const py = h - (j + 0.5) / scale
        const expected = rayCast(sites, centre, px, py, tanX, tanY)
        if (expected === null) continue
        compared++
        if (pixels[j * cols + i] !== expected + 1) wrong.push(`(${String(px)}, ${String(py)}): ${String(pixels[j * cols + i] - 1)} ≠ ${String(expected)}`)
      }
    }
    // Faces seen edge-on (on the rhombus's edge) leave many samples on an edge.
    expect(compared).toBeGreaterThan(300)
    expect(wrong).toEqual([])
  }, 30_000)

  it('grows only the open faces of voxels going on into the next slice', () => {
    // A floor two units thick through slices [0, 4) and [4, 8), baked
    // straight along the face's axis, so its sides facing up show only grown.
    const floor = VoxelGrid.fromVoxels(voxels.filter(v => v.b >= 0 && v.b < 2))
    const records = cellSurface(floor, face.lattice, 0, 4, 0, 0)
    const { data, count } = chunkFaces({ depth: 0, size: 4 }, records, 0, 0, 0, 0, 27)
    // Whether a voxel's face of `kind` is open.
    const isOpen = (a: number, b: number, c: number, kind: number) => {
      for (let r = 0; r < records.length; r += RECORD) {
        if (records[r] === a && records[r + 1] === b && records[r + 2] === c) return (records[r + 4] & (1 << kind)) !== 0
      }
      return false
    }
    const grown = Array.from({ length: count }, (_, f) => f * FACE)
      .filter(o => data.subarray(o + 10, o + 14).some(g => g > 0))
      .map(o => {
        const [a, b, c] = data.subarray(o + 14, o + 17)
        return { c, open: isOpen(a, b, c, data[o + 8] % VOXEL_FACES.length), reached: data[o + 9] }
      })
    expect(grown.length).toBeGreaterThan(0)
    // Neighbours are up to two layers on.
    expect(grown.every(({ c, open }) => open && c >= 2)).toBe(true)
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
      data[f * FACE + 9] = reached ? 1 : 0
      data.set(grow, f * FACE + 10)
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
