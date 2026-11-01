/**
 * Baking a chunk: which voxel faces a parallel projection along
 * (tanX, tanY, 1) reaches, where they land on the slice's centre plane, and
 * filling them into pixels. See DESIGN.md, section 3.
 *
 * Voxels are rhombic dodecahedra on the FCC lattice (fcc.ts), so faces are
 * rhombi, drawn as the parallelograms they project to. A slice is read in
 * its face's lattice coordinates (a, b, c) (view.ts), the same for every
 * face, and placed in face coordinates (a · LAYER, b, c · LAYER).
 *
 * No DOM and no objects per voxel or face: flat typed arrays in and out,
 * so it ports directly to a worker or to Rust/WASM.
 */
import { VOXEL_FACES } from './fcc'
import { bake, chunkCell, directionError, directionStep, sliceCentre, type SliceBoundary } from './slice-selection'
import { faceReader, type Material, type VoxelData } from './voxel-grid'
import { FACES, LAYER, type Basis } from './view'
import type { Vec3 } from './world'

/** Kinds of faces: their index in VOXEL_FACES. */
const FACE_KINDS = VOXEL_FACES.length
// The faces in a face's lattice coordinates (any face's: they see the same
// lattice). Kind k's neighbour is OFFSETS[3k ..] away (a, b, c); its normal
// is NORMALS[3k ..] and its corner i CORNERS[12k + 3i ..], in face coordinates.
const { right: R, up: U, forward: F } = FACES[0].lattice
const latticeOf = ([x, y, z]: readonly number[]) => [R, U, F].map(v => v.x * x + v.y * y + v.z * z)
const OFFSETS = Int8Array.from(VOXEL_FACES.flatMap(f => latticeOf(f.normal)))
const placed = ([a, b, c]: number[]) => [a * LAYER, b, c * LAYER]
const NORMALS = Float64Array.from(VOXEL_FACES.flatMap(f => placed(latticeOf(f.normal))))
const CORNERS = Float64Array.from(VOXEL_FACES.flatMap(f => f.corners.flatMap(c => placed(latticeOf(c)))))
// A surface record's mask: bit k (< 12) if face k is open (no neighbour across
// it); bit CUT + k if face k is drawn because the slice is cut there (its
// neighbour is in the previous slice); ON_FAR if a neighbour is in the next slice.
const OPEN_MASK = (1 << FACE_KINDS) - 1
const ON_FAR = 1 << FACE_KINDS
const CUT = 16

/** Brightness of a face by the axis it faces along, shared with the reference viewer. */
export const FACE_SHADE = { front: 0.9, back: 0.65, left: 0.7, right: 0.8, bottom: 0.55, top: 1 }

/**
 * Shade of a face by its outward normal in the world: the axes' shades
 * (FACE_SHADE) weighted by the squared components, so a face between the
 * top and the front gets the mean of both.
 */
export function faceShade({ x, y, z }: Vec3): number {
  const { front, back, left, right, bottom, top } = FACE_SHADE
  return (x * x * (x < 0 ? left : right) + y * y * (y < 0 ? bottom : top) + z * z * (z < 0 ? front : back)) / (x * x + y * y + z * z)
}

/**
 * Pixel colour of each (material, face kind) at index material · 12 + kind:
 * the material's colour times the face's shade, as opaque RGBA
 * (little-endian Uint32, as in ImageData). `lattice` is the face's (see
 * Face in view.ts), so a kind is shaded by the way it faces in the world.
 */
export function shadedPalette(materials: readonly Material[], { right, up, forward }: Basis): Uint32Array {
  const shades = VOXEL_FACES.map((_, k) => {
    const [a, b, c] = OFFSETS.subarray(3 * k, 3 * k + 3)
    return faceShade({
      x: (a * right.x + c * forward.x) / 2 + b * up.x,
      y: (a * right.y + c * forward.y) / 2 + b * up.y,
      z: (a * right.z + c * forward.z) / 2 + b * up.z,
    })
  })
  const palette = new Uint32Array(materials.length * FACE_KINDS)
  materials.forEach(({ color }, id) => {
    const rgb = parseInt(color.slice(1, 7), 16)
    shades.forEach((shade, kind) => {
      const r = Math.round(((rgb >> 16) & 255) * shade)
      const g = Math.round(((rgb >> 8) & 255) * shade)
      const b = Math.round((rgb & 255) * shade)
      palette[id * FACE_KINDS + kind] = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0
    })
  })
  return palette
}

/**
 * Ints per surface voxel record: a, b, c, material id, and a mask of its
 * open faces, the faces the slice's near plane cuts, and whether it goes on
 * past the far plane (see OPEN_MASK, CUT, ON_FAR).
 */
export const RECORD = 5

/** The largest growth chunkFaces looks for, as a tangent (directionError is about 0.5 with the defaults). */
const MAX_REACH = 1

/**
 * How far around its cell, in face units, a chunk of a slice of `size`
 * may draw voxels: rays through it reach |tan| ≤ 1 in x and LAYER in y,
 * and gap filling MAX_REACH more, over half the slice's thickness, plus
 * the extent of a voxel.
 */
function cellMargin(size: number): { x: number; y: number } {
  const half = ((size + 1) / 2) * LAYER
  return { x: (1 + MAX_REACH) * half + 1.5, y: (LAYER + MAX_REACH) * half + 1.5 }
}

/**
 * Indexes the voxels of chunk cell (i, j) (chunkCell) of the slice
 * [depth, depth + size) of a face's layers (`lattice`, see Face in
 * view.ts), and of the margin around it its chunks may show (cellMargin),
 * that have an open face (one no neighbour covers), or a face towards the
 * camera whose neighbour is in the previous slice (the slice is cut there
 * and the cut must show). Buried voxels are dropped. Voxels with a
 * neighbour in the next slice are marked (see chunkFaces). Records
 * (RECORD ints each) go by layer, far to near.
 */
export function cellSurface(grid: VoxelData, lattice: Basis, depth: number, size: number, i: number, j: number): Int32Array {
  const { columns, rows } = chunkCell(size)
  const { min, max, at } = faceReader(grid, lattice)
  const margin = cellMargin(size)
  const [ma, mb] = [Math.ceil(margin.x / LAYER), Math.ceil(margin.y)]
  // The sites, clipped to the grid's.
  const [a0, a1] = [Math.max(i * columns - ma, min.x), Math.min((i + 1) * columns + ma, max.x + 1)]
  const [b0, b1] = [Math.max(j * rows - mb, min.y), Math.min((j + 1) * rows + mb, max.y + 1)]
  const top = Math.min(depth + size, max.z + 1) - 1
  const bottom = Math.max(depth, min.z)
  if (a0 >= a1 || b0 >= b1 || top < bottom) return new Int32Array(0)

  // Layers as dense planes of the cell and the neighbours of its sites (up
  // to 2 away in a, 1 in b): site (a, b) at (b - b0 + 1) · stride + a - a0 + 2.
  const stride = a1 - a0 + 4
  const planeSize = stride * (b1 - b0 + 2)
  const offsets = VOXEL_FACES.map((_, k) => OFFSETS[3 * k + 1] * stride + OFFSETS[3 * k])
  const fill = (plane: Uint8Array, c: number) => {
    plane.fill(0)
    // A layer's sites have a and b of the parity of c.
    for (let b = b0 - 1 + ((b0 - 1 + c) & 1); b <= b1; b += 2) {
      const row = (b - b0 + 1) * stride - a0 + 2
      for (let a = a0 - 2 + ((a0 + c) & 1); a < a1 + 2; a += 2) plane[row + a] = at(a, b, c)
    }
  }

  let records = new Int32Array(256 * RECORD)
  let count = 0
  // Planes of layers c - 2 to c + 2: a voxel's neighbours (OFFSETS).
  const planes = Array.from({ length: 5 }, () => new Uint8Array(planeSize))
  for (let d = -2; d <= 2; d++) fill(planes[d + 2], top + d)
  for (let c = top; c >= bottom; c--) {
    if (c < top) {
      planes.unshift(...planes.splice(4, 1))
      fill(planes[0], c - 2)
    }
    const current = planes[2]
    for (let b = b0 + ((b0 + c) & 1); b < b1; b += 2) {
      const row = (b - b0 + 1) * stride - a0 + 2
      for (let a = a0 + ((a0 + c) & 1); a < a1; a += 2) {
        const n = row + a
        const material = current[n]
        if (material === 0) continue
        let open = 0
        let cut = 0
        let onFar = false
        for (let k = 0; k < FACE_KINDS; k++) {
          const dc = OFFSETS[3 * k + 2]
          if (planes[dc + 2][n + offsets[k]] === 0) open |= 1 << k
          else if (c + dc < depth) cut |= 1 << k
          else if (c + dc >= depth + size) onFar = true
        }
        if (open === 0 && cut === 0) continue
        if ((count + 1) * RECORD > records.length) records = grow(records, records.length * 2)
        const o = count++ * RECORD
        records[o] = a
        records[o + 1] = b
        records[o + 2] = c
        records[o + 3] = material
        records[o + 4] = open | (cut << CUT) | (onFar ? ON_FAR : 0)
      }
    }
  }
  return records.slice(0, count * RECORD)
}

function grow(array: Int32Array, length: number): Int32Array<ArrayBuffer> {
  const grown = new Int32Array(length)
  grown.set(array)
  return grown
}

/**
 * Floats per baked face: its four corners on the centre plane (x0, y0, …,
 * x3, y3, in order around it), its colour (an index into shadedPalette),
 * 1 if a ray along the baking direction reaches it (0 if only other rays
 * through the chunk do), how far past each side of its bounding box (minX,
 * minY, maxX, maxY) it is grown to fill gaps (see fillFaces), and its
 * voxel's site (a, b, c).
 */
export const FACE = 17

/** The faces of one chunk, in painting order, and the extent of their grown outlines. */
export interface ChunkFaces {
  /** count · FACE floats. A scratch buffer: valid until the next chunkFaces call. */
  data: Float64Array
  count: number
  minX: number
  maxX: number
  minY: number
  maxY: number
}

let scratch = new Float64Array(4096 * FACE)

/**
 * The faces of chunk (i, j) of a slice that a ray along (tanX, tanY, 1)
 * can reach, baked onto the slice's centre plane, in painting order: far to
 * near. A face is reached if it faces against the ray (normal · direction
 * < 0). The direction must be one of the face's rays (inFace in view.ts).
 *
 * Painting order: layers far to near. Along such a ray, each voxel it
 * passes is followed by one across a face whose normal n has
 * n · (tanX, tanY, 1) > 0: one or two layers on, or a neighbour in the
 * same layer, (±2, 0, 0) away (OFFSETS). The face to that neighbour is
 * parallel to the axis and as deep as the voxel, so a ray crosses at most
 * one such face per layer: it enters the neighbour through a face that is
 * not drawn. So voxels of one layer never cover each other, and a voxel's
 * faces facing the ray never overlap either.
 *
 * Given the slice `detail` (0 for none), faces are also grown to close the
 * gaps that open between slices (DESIGN.md, section 3): the open faces of
 * voxels with a neighbour in the next or previous slice, including ones
 * only rays up to directionError (at most MAX_REACH) off the baking
 * direction reach (marked as not reached).
 *
 * `records` is the cell's surface (cellSurface), with the margin around
 * the cell that its chunks may show.
 */
export function chunkFaces(
  { depth, size }: SliceBoundary, records: Int32Array, i0: number, j0: number, tanX: number, tanY: number, detail = 0,
): ChunkFaces {
  const { width: w, height: h } = chunkCell(size)
  const centre = sliceCentre({ depth, size })
  // A voxel reaches a layer past its own, so a slice reaches this far from its centre plane.
  const half = ((size + 1) / 2) * LAYER
  const reach = detail > 0 ? Math.min(MAX_REACH, directionError(detail)) : 0
  const [left, bottom] = [i0 * w, j0 * h]

  // A ray through the plane at p, from a camera at distance D ≥ size · detail
  // layer spacings, has tangent σ = τc + (p − cell centre) / D, and the cell's centre ray τc is
  // within half a direction step of the baking direction. A face at depth z′
  // is drawn (σ − tan) · (z′ − centre) off. On the slice's near or far
  // boundary (d = z′ − centre = −half or half) that pulls the slice's edge
  // away from the next slice's when σ is farther from the screen centre
  // than tan, so the face grows back by that much, for the largest such
  // σ − tan over a face spanning [lo, hi] along an axis. Returns the growth
  // below and above.
  const perUnit = detail > 0 ? 1 / (size * detail * LAYER) : 0
  const halfStep = detail > 0 ? directionStep(detail) / 2 : 0
  const growth = (tan: number, cellCentre: number, lo: number, hi: number, d0: number, d1: number): [number, number] => {
    const above = Math.max(0, (hi - cellCentre) * perUnit) + halfStep
    const below = Math.max(0, (cellCentre - lo) * perUnit) + halfStep
    // σ above tan opens a gap where σ > 0; below tan, where σ < 0.
    const up = above > Math.max(0, -tan) ? above : 0
    const down = below > Math.max(0, tan) ? below : 0
    return [Math.max(up * d1, down * -d0), Math.max(up * -d0, down * d1)]
  }
  const cellX = left + w / 2
  const cellY = bottom + h / 2


  const faces: ChunkFaces = { data: scratch, count: 0, minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
  const corners = new Float64Array(8)
  const emit = (kind: number, reached: boolean, r: number, gl: number, gb: number, gr: number, gt: number) => {
    if ((faces.count + 1) * FACE > scratch.length) {
      const grown = new Float64Array(scratch.length * 2)
      grown.set(scratch)
      scratch = faces.data = grown
    }
    const d = faces.data
    const o = faces.count++ * FACE
    d.set(corners, o)
    d[o + 8] = records[r * RECORD + 3] * FACE_KINDS + kind
    d[o + 9] = reached ? 1 : 0
    d[o + 10] = gl
    d[o + 11] = gb
    d[o + 12] = gr
    d[o + 13] = gt
    d[o + 14] = records[r * RECORD]
    d[o + 15] = records[r * RECORD + 1]
    d[o + 16] = records[r * RECORD + 2]
    for (let c = 0; c < 4; c++) {
      faces.minX = Math.min(faces.minX, corners[2 * c] - gl)
      faces.maxX = Math.max(faces.maxX, corners[2 * c] + gr)
      faces.minY = Math.min(faces.minY, corners[2 * c + 1] - gb)
      faces.maxY = Math.max(faces.maxY, corners[2 * c + 1] + gt)
    }
  }

  let next = 0
  for (let c = depth + size - 1; c >= depth; c--) {
    // Baking moves the layer's sites by (nearX, nearY), and each unit of depth from them by (−tanX, −tanY).
    const [nearX, nearY] = bake(0, 0, c * LAYER, tanX, tanY, centre)
    for (; next * RECORD < records.length && records[next * RECORD + 2] === c; next++) {
      const r = next
      const o = r * RECORD
      const x = records[o] * LAYER
      const y = records[o + 1]
      const mask = records[o + 4]
      const open = mask & OPEN_MASK
      const cut = (mask >> CUT) & OPEN_MASK
      // Only a voxel that goes on into the previous or next slice can open a gap.
      const d0 = cut !== 0 ? -half : 0
      const d1 = mask & ON_FAR ? half : 0
      const crossing = perUnit > 0 && d0 !== d1
      for (let k = 0; k < FACE_KINDS; k++) {
        if (!((open | cut) & (1 << k))) continue
        const a = NORMALS[3 * k]
        const b = NORMALS[3 * k + 1]
        const facing = a * tanX + b * tanY + NORMALS[3 * k + 2]
        const reached = facing < 0
        // Open faces of a crossing voxel grow, also where only rays a little off the direction reach them.
        const grows = crossing && (open & (1 << k)) !== 0
        if (!reached && !(grows && facing - (Math.abs(a) + Math.abs(b)) * reach < 0)) continue
        for (let i = 0; i < 4; i++) {
          const oz = CORNERS[12 * k + 3 * i + 2]
          corners[2 * i] = x + nearX + CORNERS[12 * k + 3 * i] - tanX * oz
          corners[2 * i + 1] = y + nearY + CORNERS[12 * k + 3 * i + 1] - tanY * oz
        }
        if (!grows) {
          emit(k, reached, r, 0, 0, 0, 0)
          continue
        }
        const l = Math.min(corners[0], corners[2], corners[4], corners[6])
        const rt = Math.max(corners[0], corners[2], corners[4], corners[6])
        const bt = Math.min(corners[1], corners[3], corners[5], corners[7])
        const tp = Math.max(corners[1], corners[3], corners[5], corners[7])
        const [gl, gr] = growth(tanX, cellX, l, rt, d0, d1)
        const [gb, gt] = growth(tanY, cellY, bt, tp, d0, d1)
        emit(k, reached, r, gl, gb, gr, gt)
      }
    }
  }
  return faces
}

// Spans written by rasterise: row, from, to per span.
let spans = new Int32Array(3 * 256)
// rasterise's edges: upper y, lower y, x at the upper end, dx / dy.
const edges = new Float64Array(4 * 8)

/**
 * Writes into `spans` (row, from, to triples) the pixels of each row whose
 * centre is in the convex polygon `points` (n ≤ 8 x, y pairs in pixel
 * coordinates, y down), clipped to width × height, and returns how many
 * spans there are. Edges are half-open (an edge from y0 to y1 covers
 * [y0, y1) across, [x_left, x_right) along a row), and an edge is evaluated
 * from its upper end whichever polygon it belongs to, so polygons sharing an
 * edge neither overlap nor leave a gap there.
 */
function rasterise(points: Float64Array, n: number, width: number, height: number): number {
  let minY = Infinity
  let maxY = -Infinity
  let m = 0
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1
    let px = points[2 * i]
    let py = points[2 * i + 1]
    let qx = points[2 * j]
    let qy = points[2 * j + 1]
    if (py < minY) minY = py
    if (py > maxY) maxY = py
    if (py === qy) continue
    if (py > qy) {
      const tx = px
      const ty = py
      px = qx
      py = qy
      qx = tx
      qy = ty
    }
    edges[4 * m] = py
    edges[4 * m + 1] = qy
    edges[4 * m + 2] = px
    edges[4 * m + 3] = (qx - px) / (qy - py)
    m++
  }
  const first = Math.max(0, Math.ceil(minY - 0.5))
  const last = Math.min(height, Math.ceil(maxY - 0.5))
  if (last - first > spans.length / 3) spans = new Int32Array(3 * 2 ** Math.ceil(Math.log2(last - first)))
  let count = 0
  for (let row = first; row < last; row++) {
    const yc = row + 0.5
    let left = Infinity
    let right = -Infinity
    for (let e = 0; e < m; e++) {
      const o = 4 * e
      if (yc < edges[o] || yc >= edges[o + 1]) continue
      const x = edges[o + 2] + edges[o + 3] * (yc - edges[o])
      if (x < left) left = x
      if (x > right) right = x
    }
    const from = Math.max(0, Math.ceil(left - 0.5))
    const to = Math.min(width, Math.ceil(right - 0.5))
    if (from >= to) continue
    spans[3 * count] = row
    spans[3 * count + 1] = from
    spans[3 * count + 2] = to
    count++
  }
  return count
}

// sweep's output.
const swept = new Float64Array(16)

/**
 * The quadrilateral `quad` (x, y pairs) swept over the rectangle
 * [-left, right] × [-up, down] (their Minkowski sum), written to the start of
 * `quad`; returns its number of corners (at most 8). Both are convex, so
 * their edges are merged by angle.
 */
function sweep(quad: Float64Array, left: number, up: number, right: number, down: number): number {
  // Counter-clockwise (positive area, with y as given), starting at the lowest corner.
  const area = (quad[2] - quad[0]) * (quad[5] - quad[1]) - (quad[3] - quad[1]) * (quad[4] - quad[0])
  const at = (i: number) => (area >= 0 ? i : 8 - i) % 4
  let start = 0
  for (let i = 1; i < 4; i++) {
    if (quad[2 * i + 1] < quad[2 * start + 1] || (quad[2 * i + 1] === quad[2 * start + 1] && quad[2 * i] < quad[2 * start])) start = i
  }
  const startStep = area >= 0 ? start : (8 - start) % 4
  // The rectangle's corners counter-clockwise from the lowest: (−left, −up), (right, −up), (right, down), (−left, down).
  const rx = [-left, right, right, -left]
  const ry = [-up, -up, down, down]
  let i = 0
  let j = 0
  let n = 0
  while (i < 4 || j < 4) {
    const p = at(startStep + i)
    swept[2 * n] = quad[2 * p] + rx[j % 4]
    swept[2 * n + 1] = quad[2 * p + 1] + ry[j % 4]
    n++
    const q = at(startStep + i + 1)
    const ex = quad[2 * q] - quad[2 * p]
    const ey = quad[2 * q + 1] - quad[2 * p + 1]
    const fx = rx[(j + 1) % 4] - rx[j % 4]
    const fy = ry[(j + 1) % 4] - ry[j % 4]
    const turn = ex * fy - ey * fx
    // A side of zero length (no growth that way) is passed alone.
    if (j < 4 && fx === 0 && fy === 0) j++
    else if (i < 4 && ex === 0 && ey === 0) i++
    else if (j === 4 || (i < 4 && turn > 0)) i++
    else if (i === 4 || turn < 0) j++
    else {
      i++
      j++
    }
  }
  quad.set(swept.subarray(0, 2 * n))
  return n
}

// fillFaces' map to the next empty pixel, reused.
let nextEmpty = new Int32Array(0)

/**
 * Fills baked faces into a width × height pixel buffer showing the centre
 * plane from (originX, originY) (top-left) at `scale` pixels per unit,
 * without antialiasing: a pixel is filled when its centre is inside, with
 * half-open edges, so faces sharing an edge neither overlap nor leave a gap
 * there. Faces the baking direction reaches are painted in order.
 *
 * Then every face, grown (its outline swept over the rectangle of its
 * growth, see FACE), is painted where nothing is yet, nearest first. This
 * closes the gaps between slices (DESIGN.md, section 3) without changing
 * what the chunk already shows. Returns how many faces covered a pixel.
 */
export function fillFaces(
  faces: ChunkFaces, palette: Uint32Array,
  pixels: Uint32Array, width: number, height: number, originX: number, originY: number, scale: number,
): number {
  const { data } = faces
  const polygon = new Float64Array(32)
  // Face f's corners in pixel coordinates.
  const outline = (f: number) => {
    const o = f * FACE
    for (let c = 0; c < 4; c++) {
      polygon[2 * c] = (data[o + 2 * c] - originX) * scale
      polygon[2 * c + 1] = (originY - data[o + 2 * c + 1]) * scale
    }
  }
  const covered = new Uint8Array(faces.count)
  for (let f = 0; f < faces.count; f++) {
    if (data[f * FACE + 9] === 0) continue
    outline(f)
    const color = palette[data[f * FACE + 8]]
    const count = rasterise(polygon, 4, width, height)
    for (let k = 0; k < count; k++) {
      const row = spans[3 * k] * width
      pixels.fill(color, row + spans[3 * k + 1], row + spans[3 * k + 2])
    }
    if (count > 0) covered[f] = 1
  }
  // next[i] leads to the first empty pixel at or after i (by path halving),
  // so the grown faces skip what is painted.
  const area = width * height
  if (nextEmpty.length <= area) nextEmpty = new Int32Array(2 ** Math.ceil(Math.log2(area + 1)))
  const next = nextEmpty
  for (let i = 0; i < area; i++) next[i] = pixels[i] === 0 ? i : i + 1
  next[area] = area
  const empty = (i: number) => {
    while (next[i] !== i) i = next[i] = next[next[i]]
    return i
  }
  for (let f = faces.count - 1; f >= 0; f--) {
    const o = f * FACE
    const gl = data[o + 10] * scale
    const gb = data[o + 11] * scale
    const gr = data[o + 12] * scale
    const gt = data[o + 13] * scale
    const flat = gl === 0 && gb === 0 && gr === 0 && gt === 0
    // A reached face that is not grown is painted already.
    if (flat && data[o + 9] === 1) continue
    outline(f)
    let n = 4
    if (!flat) {
      // The outline swept over the growth rectangle (pixel y is down, so up is −y).
      n = sweep(polygon, gl, gt, gr, gb)
    }
    const color = palette[data[o + 8]]
    const count = rasterise(polygon, n, width, height)
    for (let k = 0; k < count; k++) {
      const row = spans[3 * k] * width
      const to = row + spans[3 * k + 2]
      for (let i = empty(row + spans[3 * k + 1]); i < to; i = empty(i + 1)) {
        pixels[i] = color
        next[i] = i + 1
        covered[f] = 1
      }
    }
  }
  return covered.reduce((n, c) => n + c, 0)
}
