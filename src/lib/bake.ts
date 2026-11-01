/**
 * Baking a chunk: which voxel faces a parallel projection along
 * (tanX, tanY, 1) reaches, where they land on the slice's centre plane, and
 * filling them into pixels. See DESIGN.md, section 3.
 *
 * Voxels are rhombic dodecahedra on the FCC lattice (fcc.ts), so faces are
 * rhombi, drawn as the parallelograms they project to.
 *
 * No DOM and no objects per voxel or face: flat typed arrays in and out,
 * so it ports directly to a worker or to Rust/WASM.
 */
import { VOXEL_FACES } from './fcc'
import { bake, chunkWidth, directionError, directionStep, sliceCentre } from './slice-selection'
import { faceReader, type Material, type VoxelData } from './voxel-grid'
import type { Basis } from './view'
import type { Vec3 } from './world'

/** Kinds of faces: their index in VOXEL_FACES. */
const FACE_KINDS = VOXEL_FACES.length
// VOXEL_FACES flattened: normal k is NORMALS[3k ..], its corner i CORNERS[12k + 3i ..].
const NORMALS = Int8Array.from(VOXEL_FACES.flatMap(f => f.normal))
const CORNERS = Float64Array.from(VOXEL_FACES.flatMap(f => f.corners.flat()))
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
 * (little-endian Uint32, as in ImageData). `axes` are the face's axes in the
 * world (see faceReader), so a kind is shaded by the way it faces in the
 * world.
 */
export function shadedPalette(materials: readonly Material[], { right, up, forward }: Basis): Uint32Array {
  const shades = VOXEL_FACES.map(({ normal: [a, b, c] }) => faceShade({
    x: a * right.x + b * up.x + c * forward.x,
    y: a * right.y + b * up.y + c * forward.y,
    z: a * right.z + b * up.z + c * forward.z,
  }))
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
 * Ints per surface voxel record: x, y, z, material id, and a mask of its
 * open faces, the faces the slice's near plane cuts, and whether it goes on
 * past the far plane (see OPEN_MASK, CUT, ON_FAR).
 */
export const RECORD = 5

/**
 * The voxels of one slice that have a face to draw, grouped by chunk cell.
 * Cell (i, j) is the chunk with corner ((cellX + i) · width, (cellY + j) · width);
 * its records are records[cellStart[k] · RECORD ..] up to cellStart[k + 1],
 * k = j · cellsX + i, ordered far to near.
 */
export interface SliceSurface {
  depth: number
  size: number
  /** Chunk width, see chunkWidth. */
  width: number
  cellX: number
  cellY: number
  cellsX: number
  cellsY: number
  cellStart: Uint32Array
  records: Int32Array
}

/**
 * Indexes the slice [depth, depth + size) of `grid` seen along `axes`
 * (in the face's coordinates, see faceReader): the voxels with an open face
 * (one no neighbour covers), or a front face whose neighbour is in the
 * previous slice (the slice is cut there and the cut must show), by chunk
 * cell. Buried voxels are dropped. Voxels with a neighbour in the next slice
 * are marked (see chunkFaces).
 */
export function sliceSurface(grid: VoxelData, axes: Basis, depth: number, size: number): SliceSurface {
  const width = chunkWidth(size)
  const { min, max, at } = faceReader(grid, axes)
  const empty = min.x > max.x || min.y > max.y || min.z > max.z
  const cellX = Math.floor(min.x / width)
  const cellY = Math.floor(min.y / width)
  const cellsX = empty ? 0 : Math.floor(max.x / width) - cellX + 1
  const cellsY = empty ? 0 : Math.floor(max.y / width) - cellY + 1

  // Layers of sites as dense planes with a border of empty sites, so
  // neighbours need no bounds checks: site (u, v) at (v - min.y + 1) · stride + u - min.x + 1.
  const stride = max.x - min.x + 3
  const planeSize = empty ? 0 : stride * (max.y - min.y + 3)
  const offsets = VOXEL_FACES.map(({ normal: [a, b] }) => b * stride + a)
  const fill = (plane: Uint8Array, w: number) => {
    plane.fill(0)
    if (w < min.z || w > max.z) return
    for (let v = min.y; v <= max.y; v++) {
      const row = (v - min.y + 1) * stride - min.x + 1
      for (let u = min.x + ((min.x + v + w) & 1); u <= max.x; u += 2) plane[row + u] = at(u, v, w)
    }
  }

  // Records in scan order (far to near), with their cell, then grouped by
  // cell with a stable counting sort.
  let scanned = new Int32Array(1024 * RECORD)
  let cellOf = new Int32Array(1024)
  let count = 0
  const top = Math.min(depth + size, max.z + 1) - 1
  const bottom = Math.max(depth, min.z)
  // Planes of layers z + 1, z and z − 1.
  let [next, current, previous] = [new Uint8Array(planeSize), new Uint8Array(planeSize), new Uint8Array(planeSize)]
  if (top >= bottom) {
    fill(next, top + 1)
    fill(current, top)
    fill(previous, top - 1)
  }
  for (let z = top; z >= bottom; z--) {
    if (z < top) {
      ;[next, current, previous] = [current, previous, next]
      fill(previous, z - 1)
    }
    for (let y = min.y; y <= max.y; y++) {
      const row = (y - min.y + 1) * stride - min.x + 1
      for (let x = min.x + ((min.x + y + z) & 1); x <= max.x; x += 2) {
        const i = row + x
        const material = current[i]
        if (material === 0) continue
        let open = 0
        let cut = 0
        let onFar = false
        for (let k = 0; k < FACE_KINDS; k++) {
          const c = NORMALS[3 * k + 2]
          const neighbour = (c < 0 ? previous : c > 0 ? next : current)[i + offsets[k]]
          if (neighbour === 0) open |= 1 << k
          else if (c < 0 && z === depth) cut |= 1 << k
          else if (c > 0 && z === depth + size - 1) onFar = true
        }
        if (open === 0 && cut === 0) continue
        if (count === cellOf.length) {
          scanned = grow(scanned, scanned.length * 2)
          cellOf = grow(cellOf, cellOf.length * 2)
        }
        const o = count * RECORD
        scanned[o] = x
        scanned[o + 1] = y
        scanned[o + 2] = z
        scanned[o + 3] = material
        scanned[o + 4] = open | (cut << CUT) | (onFar ? ON_FAR : 0)
        cellOf[count++] = (Math.floor(y / width) - cellY) * cellsX + Math.floor(x / width) - cellX
      }
    }
  }

  const cellStart = new Uint32Array(cellsX * cellsY + 1)
  for (let n = 0; n < count; n++) cellStart[cellOf[n] + 1]++
  for (let k = 0; k < cellsX * cellsY; k++) cellStart[k + 1] += cellStart[k]
  const nextOf = cellStart.slice(0, -1)
  const records = new Int32Array(count * RECORD)
  for (let n = 0; n < count; n++) {
    const to = nextOf[cellOf[n]]++ * RECORD
    for (let k = 0; k < RECORD; k++) records[to + k] = scanned[n * RECORD + k]
  }
  return { depth, size, width, cellX, cellY, cellsX, cellsY, cellStart, records }
}

function grow(array: Int32Array, length: number): Int32Array<ArrayBuffer> {
  const grown = new Int32Array(length)
  grown.set(array)
  return grown
}

/**
 * Floats per baked face: its four corners on the centre plane (x0, y0, …,
 * x3, y3, in order around it), its colour (an index into shadedPalette),
 * the index of its voxel's record, 1 if a ray along the baking direction
 * reaches it (0 if only other rays through the chunk do), and how far past
 * each side of its bounding box (minX, minY, maxX, maxY) it is grown to fill
 * gaps (see fillFaces).
 */
export const FACE = 15

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
let order = new Int32Array(1024)

// The chunk's own cell and its neighbours.
const NEIGHBOURS = [[0, 0], [-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]

/**
 * The faces of chunk (x0, y0) of `surface` that a ray along (tanX, tanY, 1)
 * can reach, baked onto the slice's centre plane, in painting order: far to
 * near. A face is reached if it faces against the ray (normal · direction
 * < 0). |tanX| and |tanY| must be at most 1.
 *
 * Painting order. Along a ray, each voxel it passes is followed by one
 * across a face whose normal n has n · (tanX, tanY, 1) > 0, so with tangents
 * at most 1 the next voxel is in the same layer (z) or the next one. Layers
 * are painted far to near, and within one layer voxels by tanX · x + tanY · y,
 * largest first: on a ray it grows from voxel to voxel. (Sorting by the
 * site's distance along the direction orders any Voronoi tiling like this.)
 * A voxel's faces facing the ray never overlap, so their order is free.
 *
 * Given the slice `detail` (0 for none), faces are also grown to close the
 * gaps that open between slices (DESIGN.md, section 3): the open faces of
 * voxels with a neighbour in the next or previous slice, including ones
 * only rays a little off the baking direction reach (marked as not
 * reached). They grow about directionError · (size + 1) / 2, so only
 * voxels within (|tan| + directionError) · (size + 1) / 2 + 1.5 of the cell
 * (the slack covers faces just outside it, which grow a little more), less
 * than a cell width, are looked at: the cell and its eight neighbours.
 */
export function chunkFaces(
  surface: SliceSurface, x0: number, y0: number, tanX: number, tanY: number, detail = 0,
): ChunkFaces {
  const { depth, size, width: w, records } = surface
  const centre = sliceCentre(surface)
  // A voxel reaches 1 past its layer, so a slice reaches this far from its centre plane.
  const half = (size + 1) / 2
  const reach = detail > 0 ? directionError(detail) : 0
  const marginX = (Math.abs(tanX) + reach) * half + 1.5
  const marginY = (Math.abs(tanY) + reach) * half + 1.5
  const near = (x: number, y: number) =>
    x > x0 - 1 - marginX && x < x0 + w + marginX && y > y0 - 1 - marginY && y < y0 + w + marginY

  // A ray through the plane at p, from a camera at distance D ≥ size · detail,
  // has tangent σ = τc + (p − cell centre) / D, and the cell's centre ray τc is
  // within half a direction step of the baking direction. A face at depth z′
  // is drawn (σ − tan) · (z′ − centre) off. On the slice's near or far
  // boundary (d = z′ − centre = −half or half) that pulls the slice's edge
  // away from the next slice's when σ is farther from the screen centre
  // than tan, so the face grows back by that much, for the largest such
  // σ − tan over a face spanning [lo, hi] along an axis. Returns the growth
  // below and above.
  const perUnit = detail > 0 ? 1 / (size * detail) : 0
  const halfStep = detail > 0 ? directionStep(detail) / 2 : 0
  const growth = (tan: number, cellCentre: number, lo: number, hi: number, d0: number, d1: number): [number, number] => {
    const above = Math.max(0, (hi - cellCentre) * perUnit) + halfStep
    const below = Math.max(0, (cellCentre - lo) * perUnit) + halfStep
    // σ above tan opens a gap where σ > 0; below tan, where σ < 0.
    const up = above > Math.max(0, -tan) ? above : 0
    const down = below > Math.max(0, tan) ? below : 0
    return [Math.max(up * d1, down * -d0), Math.max(up * -d0, down * d1)]
  }
  const cellX = x0 + w / 2 - 0.5
  const cellY = y0 + w / 2 - 0.5

  // Record ranges of the cells, each far to near; neighbours' voxels are
  // checked for being near.
  const cells: { next: number; end: number; check: boolean }[] = []
  for (const [di, dj] of NEIGHBOURS) {
    const i = x0 / w - surface.cellX + di
    const j = y0 / w - surface.cellY + dj
    if (i < 0 || i >= surface.cellsX || j < 0 || j >= surface.cellsY) continue
    const k = j * surface.cellsX + i
    cells.push({ next: surface.cellStart[k], end: surface.cellStart[k + 1], check: di !== 0 || dj !== 0 })
  }

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
    d[o + 9] = r
    d[o + 10] = reached ? 1 : 0
    d[o + 11] = gl
    d[o + 12] = gb
    d[o + 13] = gr
    d[o + 14] = gt
    for (let c = 0; c < 4; c++) {
      faces.minX = Math.min(faces.minX, corners[2 * c] - gl)
      faces.maxX = Math.max(faces.maxX, corners[2 * c] + gr)
      faces.minY = Math.min(faces.minY, corners[2 * c + 1] - gb)
      faces.maxY = Math.max(faces.maxY, corners[2 * c + 1] + gt)
    }
  }

  for (let z = depth + size - 1; z >= depth; z--) {
    // Baking moves the layer's sites by (nearX, nearY), and each unit of depth from them by (−tanX, −tanY).
    const [nearX, nearY] = bake(0, 0, z, tanX, tanY, centre)
    // This layer's voxels within reach of the chunk, painted by tanX · x + tanY · y, largest first.
    let n = 0
    for (const cell of cells) {
      let r = cell.next
      for (; r < cell.end && records[r * RECORD + 2] === z; r++) {
        if (cell.check && !near(records[r * RECORD], records[r * RECORD + 1])) continue
        if (n === order.length) {
          const grown = new Int32Array(order.length * 2)
          grown.set(order)
          order = grown
        }
        order[n++] = r
      }
      cell.next = r
    }
    const layer = order.subarray(0, n)
    if (tanX !== 0 || tanY !== 0) {
      layer.sort((a, b) => tanX * (records[b * RECORD] - records[a * RECORD]) + tanY * (records[b * RECORD + 1] - records[a * RECORD + 1]))
    }

    for (let q = 0; q < n; q++) {
      const r = layer[q]
      const o = r * RECORD
      const x = records[o]
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
    if (data[f * FACE + 10] === 0) continue
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
    const gl = data[o + 11] * scale
    const gb = data[o + 12] * scale
    const gr = data[o + 13] * scale
    const gt = data[o + 14] * scale
    const flat = gl === 0 && gb === 0 && gr === 0 && gt === 0
    // A reached face that is not grown is painted already.
    if (flat && data[o + 10] === 1) continue
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
