/**
 * Baking a chunk: which voxel faces a parallel projection along
 * (tanX, tanY, 1) reaches, where they land on the slice's centre plane, and
 * filling them into pixels. See DESIGN.md, section 3.
 *
 * No DOM and no objects per voxel or face: flat typed arrays in and out,
 * so it ports directly to a worker or to Rust/WASM.
 */
import { bake, chunkWidth, sliceCentre } from './slice-selection'
import type { Material, VoxelData } from './voxel-grid'

// Faces of a voxel a bake can show, by kind; the open-face mask has bit 1 << kind.
const FRONT = 0
const LEFT = 1
const RIGHT = 2
const BOTTOM = 3
const TOP = 4
const FACE_KINDS = 5

/** Brightness of each face, shared with the reference viewer. */
export const FACE_SHADE = { front: 0.9, back: 0.65, left: 0.7, right: 0.8, bottom: 0.55, top: 1 }
const KIND_SHADES = [FACE_SHADE.front, FACE_SHADE.left, FACE_SHADE.right, FACE_SHADE.bottom, FACE_SHADE.top]

/**
 * Pixel colour of each (material, face kind) at index material · 5 + kind:
 * the material's colour times the face's shade, as opaque RGBA
 * (little-endian Uint32, as in ImageData).
 */
export function shadedPalette(materials: readonly Material[]): Uint32Array {
  const palette = new Uint32Array(materials.length * FACE_KINDS)
  materials.forEach(({ color }, id) => {
    const rgb = parseInt(color.slice(1, 7), 16)
    KIND_SHADES.forEach((shade, kind) => {
      const r = Math.round(((rgb >> 16) & 255) * shade)
      const g = Math.round(((rgb >> 8) & 255) * shade)
      const b = Math.round((rgb & 255) * shade)
      palette[id * FACE_KINDS + kind] = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0
    })
  })
  return palette
}

/** Ints per surface voxel record: x, y, z, material id, open-face mask. */
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
 * Indexes the slice [depth, depth + size) of `grid`: the voxels with an open
 * face (one no neighbour covers; the front face also on the near plane,
 * where the slice is cut and the cut must show), by chunk cell. Buried
 * voxels are dropped.
 */
export function sliceSurface(grid: VoxelData, depth: number, size: number): SliceSurface {
  const width = chunkWidth(size)
  const { minX, minY, minZ, nx, ny, nz, cells } = grid
  const cellX = Math.floor(minX / width)
  const cellY = Math.floor(minY / width)
  const cellsX = nx > 0 ? Math.floor((minX + nx - 1) / width) - cellX + 1 : 0
  const cellsY = ny > 0 ? Math.floor((minY + ny - 1) / width) - cellY + 1 : 0
  const plane = nx * ny

  // Records in scan order (far to near), with their cell, then grouped by
  // cell with a stable counting sort.
  let scanned = new Int32Array(1024 * RECORD)
  let cellOf = new Int32Array(1024)
  let count = 0
  for (let z = Math.min(depth + size, minZ + nz) - 1; z >= Math.max(depth, minZ); z--) {
    for (let y = minY; y < minY + ny; y++) {
      let i = ((z - minZ) * ny + (y - minY)) * nx
      for (let x = minX; x < minX + nx; x++, i++) {
        const material = cells[i]
        if (material === 0) continue
        const open =
          (z === depth || z === minZ || cells[i - plane] === 0 ? 1 << FRONT : 0) |
          (x === minX || cells[i - 1] === 0 ? 1 << LEFT : 0) |
          (x === minX + nx - 1 || cells[i + 1] === 0 ? 1 << RIGHT : 0) |
          (y === minY || cells[i - nx] === 0 ? 1 << BOTTOM : 0) |
          (y === minY + ny - 1 || cells[i + nx] === 0 ? 1 << TOP : 0)
        if (open === 0) continue
        if (count === cellOf.length) {
          scanned = grow(scanned, scanned.length * 2)
          cellOf = grow(cellOf, cellOf.length * 2)
        }
        const o = count * RECORD
        scanned[o] = x
        scanned[o + 1] = y
        scanned[o + 2] = z
        scanned[o + 3] = material
        scanned[o + 4] = open
        cellOf[count++] = (Math.floor(y / width) - cellY) * cellsX + Math.floor(x / width) - cellX
      }
    }
  }

  const cellStart = new Uint32Array(cellsX * cellsY + 1)
  for (let n = 0; n < count; n++) cellStart[cellOf[n] + 1]++
  for (let k = 0; k < cellsX * cellsY; k++) cellStart[k + 1] += cellStart[k]
  const next = cellStart.slice(0, -1)
  const records = new Int32Array(count * RECORD)
  for (let n = 0; n < count; n++) {
    const to = next[cellOf[n]]++ * RECORD
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
 * Floats per baked face: its rectangle on the centre plane (minX, minY,
 * maxX, maxY), its colour (an index into shadedPalette), the index of
 * its voxel's record, and how far perspective may show it past its
 * rectangle (see fillFaces).
 */
export const FACE = 7

/** The faces of one chunk, in painting order, and the extent of their grown rectangles. */
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

// The chunk's own cell and its neighbours, in the order their faces are painted at equal z.
const NEIGHBOURS = [[0, 0], [-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]

/**
 * The faces of chunk (x0, y0) of `surface` that a ray along (tanX, tanY, 1)
 * can reach, baked onto the slice's centre plane, in painting order: far to
 * near, and side faces before the front faces of the same z, which are
 * nearer. A ray going +x enters a voxel through its −x face, and so on.
 *
 * The chunk may be seen along rays up to `spread` (a tangent) off that
 * direction. Such a ray sees a point at depth z′ shifted by up to
 * spread · |z′ − centre| on the plane, so each face records that much,
 * over its depths, as how far it may show past its rectangle.
 *
 * Voxels whose grown projection can reach the chunk's cell are within
 * (|tan| + spread) · size / 2 + 1 of it, less than a cell width, so only
 * the cell and its eight neighbours are looked at.
 */
export function chunkFaces(
  surface: SliceSurface, x0: number, y0: number, tanX: number, tanY: number, spread = 0,
): ChunkFaces {
  const { depth, size, width: w, records } = surface
  const centre = sliceCentre(surface)
  const marginX = ((Math.abs(tanX) + spread) * size) / 2 + 1
  const marginY = ((Math.abs(tanY) + spread) * size) / 2 + 1
  const near = (x: number, y: number) =>
    x > x0 - 1 - marginX && x < x0 + w + marginX && y > y0 - 1 - marginY && y < y0 + w + marginY
  const sideX = Math.sign(tanX)
  const sideY = Math.sign(tanY)
  const kindX = sideX > 0 ? LEFT : RIGHT
  const kindY = sideY > 0 ? BOTTOM : TOP

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
  const emit = (kind: number, r: number, minX: number, minY: number, maxX: number, maxY: number, grow: number) => {
    if ((faces.count + 1) * FACE > scratch.length) {
      const grown = new Float64Array(scratch.length * 2)
      grown.set(scratch)
      scratch = faces.data = grown
    }
    const d = faces.data
    const o = faces.count++ * FACE
    d[o] = minX
    d[o + 1] = minY
    d[o + 2] = maxX
    d[o + 3] = maxY
    d[o + 4] = records[r * RECORD + 3] * FACE_KINDS + kind
    d[o + 5] = r
    d[o + 6] = grow
    faces.minX = Math.min(faces.minX, minX - grow)
    faces.maxX = Math.max(faces.maxX, maxX + grow)
    faces.minY = Math.min(faces.minY, minY - grow)
    faces.maxY = Math.max(faces.maxY, maxY + grow)
  }

  // A side face is its voxel's edge swept one unit deep: a parallelogram.
  // It is drawn as its bounding rectangle, which covers a little more, never less.
  const [lowX, highX] = [Math.min(0, -tanX), Math.max(0, -tanX)]
  const [lowY, highY] = [Math.min(0, -tanY), Math.max(0, -tanY)]
  for (let z = depth + size - 1; z >= depth; z--) {
    // Baking shifts the plane z − 0.5 by (nearX, nearY), and each unit of depth by (−tanX, −tanY).
    const [nearX, nearY] = bake(0, 0, z - 0.5, tanX, tanY, centre)
    // Front faces lie at z − 0.5, side faces span z ± 0.5.
    const growFront = spread * Math.abs(z - 0.5 - centre)
    const growSide = spread * (Math.abs(z - centre) + 0.5)
    const runs = cells.map(cell => {
      let stop = cell.next
      while (stop < cell.end && records[stop * RECORD + 2] === z) stop++
      const run = { from: cell.next, to: stop, check: cell.check }
      cell.next = stop
      return run
    })
    // Voxel records of this z within reach of the chunk.
    const eachVoxel = (visit: (r: number, x: number, y: number, open: number) => void) => {
      for (const { from, to, check } of runs) {
        for (let r = from; r < to; r++) {
          const x = records[r * RECORD]
          const y = records[r * RECORD + 1]
          if (!check || near(x, y)) visit(r, x, y, records[r * RECORD + 4])
        }
      }
    }
    // Corner of a voxel's front face on the plane.
    const left = (x: number) => x - 0.5 + nearX
    const bottom = (y: number) => y - 0.5 + nearY
    eachVoxel((r, x, y, open) => {
      if (sideX !== 0 && open & (1 << kindX)) {
        const edge = left(x) + (sideX > 0 ? 0 : 1)
        emit(kindX, r, edge + lowX, bottom(y) + lowY, edge + highX, bottom(y) + 1 + highY, growSide)
      }
      if (sideY !== 0 && open & (1 << kindY)) {
        const edge = bottom(y) + (sideY > 0 ? 0 : 1)
        emit(kindY, r, left(x) + lowX, edge + lowY, left(x) + 1 + highX, edge + highY, growSide)
      }
    })
    eachVoxel((r, x, y, open) => {
      if (open & (1 << FRONT)) emit(FRONT, r, left(x), bottom(y), left(x) + 1, bottom(y) + 1, growFront)
    })
  }
  return faces
}

// fillFaces' map to the next empty pixel, reused.
let nextEmpty = new Int32Array(0)

/**
 * Fills baked faces into a width × height pixel buffer showing the centre
 * plane from (originX, originY) (top-left) at `scale` pixels per unit,
 * without antialiasing: a pixel is filled when its centre is inside, with
 * half-open edges, so faces sharing an edge neither overlap nor leave a gap
 * there. Faces are painted in order.
 *
 * Then every face, grown by how far perspective may show it past its
 * rectangle (see FACE), is painted where nothing is yet, nearest first.
 * This covers the gaps slices and chunks open (DESIGN.md, section 3)
 * without changing what the chunk already shows. Returns how many faces
 * covered a pixel.
 */
export function fillFaces(
  faces: ChunkFaces, palette: Uint32Array,
  pixels: Uint32Array, width: number, height: number, originX: number, originY: number, scale: number,
): number {
  const { data } = faces
  // The first pixel whose centre is at or past u units from the origin.
  const pixel = (u: number) => Math.ceil(u * scale - 0.5)
  // Pixel rectangle of face f grown by g, clipped to the buffer.
  const rect = (f: number, g: number) => {
    const o = f * FACE
    return {
      from: Math.max(0, pixel(data[o] - g - originX)),
      top: Math.max(0, pixel(originY - data[o + 3] - g)),
      to: Math.min(width, pixel(data[o + 2] + g - originX)),
      bottom: Math.min(height, pixel(originY - data[o + 1] + g)),
    }
  }
  const covered = new Uint8Array(faces.count)
  for (let f = 0; f < faces.count; f++) {
    const { from, top, to, bottom } = rect(f, 0)
    if (from >= to || top >= bottom) continue
    const color = palette[data[f * FACE + 4]]
    for (let row = top; row < bottom; row++) pixels.fill(color, row * width + from, row * width + to)
    covered[f] = 1
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
    const { from, top, to, bottom } = rect(f, data[f * FACE + 6])
    if (from >= to) continue
    const color = palette[data[f * FACE + 4]]
    for (let row = top; row < bottom; row++) {
      for (let i = empty(row * width + from); i < row * width + to; i = empty(i + 1)) {
        pixels[i] = color
        next[i] = i + 1
        covered[f] = 1
      }
    }
  }
  return covered.reduce((n, c) => n + c, 0)
}
