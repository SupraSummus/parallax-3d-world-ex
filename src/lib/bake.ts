/**
 * Baking a chunk: which voxel faces a parallel projection along
 * (tanX, tanY, 1) reaches, where they land on the slice's centre plane, and
 * filling them into pixels. See DESIGN.md, section 3.
 *
 * No DOM and no objects per voxel or face: flat typed arrays in and out,
 * so it ports directly to a worker or to Rust/WASM.
 */
import { bake, chunkWidth, directionError, directionStep, sliceCentre } from './slice-selection'
import type { Material, VoxelData } from './voxel-grid'
import type { Basis } from './view'
import type { Vec3 } from './world'

// Faces of a voxel a bake can show, by kind; the open-face mask has bit 1 << kind.
const FRONT = 0
const LEFT = 1
const RIGHT = 2
const BOTTOM = 3
const TOP = 4
const FACE_KINDS = 5
// More bits of the mask: the voxel goes on past the slice's near or far plane.
const ON_NEAR = 1 << 5
const ON_FAR = 1 << 6

/** Brightness of each face, shared with the reference viewer. */
export const FACE_SHADE = { front: 0.9, back: 0.65, left: 0.7, right: 0.8, bottom: 0.55, top: 1 }

/** Shade of a voxel face by its outward normal in the world. */
function shadeOf({ x, y, z }: Vec3): number {
  if (x !== 0) return x < 0 ? FACE_SHADE.left : FACE_SHADE.right
  if (y !== 0) return y < 0 ? FACE_SHADE.bottom : FACE_SHADE.top
  return z < 0 ? FACE_SHADE.front : FACE_SHADE.back
}

const negate = ({ x, y, z }: Vec3): Vec3 => ({ x: -x, y: -y, z: -z })

/**
 * Pixel colour of each (material, face kind) at index material · 5 + kind:
 * the material's colour times the face's shade, as opaque RGBA
 * (little-endian Uint32, as in ImageData). `axes` are the grid's axes in
 * the world (see rotateGrid), so a kind is shaded by the way it faces in
 * the world.
 */
export function shadedPalette(materials: readonly Material[], { right, up, forward }: Basis): Uint32Array {
  // Outward normals of FRONT, LEFT, RIGHT, BOTTOM, TOP.
  const shades = [negate(forward), negate(right), right, negate(up), up].map(shadeOf)
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
 * open faces and whether it goes on past the slice's planes (ON_NEAR, ON_FAR).
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
 * Indexes the slice [depth, depth + size) of `grid`: the voxels with an open
 * face (one no neighbour covers; the front face also on the near plane,
 * where the slice is cut and the cut must show), by chunk cell. Buried
 * voxels are dropped. Voxels on the near or far plane are marked if the
 * next slice has a voxel behind them (see chunkFaces).
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
        const on =
          (z === depth && z > minZ && cells[i - plane] !== 0 ? ON_NEAR : 0) |
          (z === depth + size - 1 && z < minZ + nz - 1 && cells[i + plane] !== 0 ? ON_FAR : 0)
        if (count === cellOf.length) {
          scanned = grow(scanned, scanned.length * 2)
          cellOf = grow(cellOf, cellOf.length * 2)
        }
        const o = count * RECORD
        scanned[o] = x
        scanned[o + 1] = y
        scanned[o + 2] = z
        scanned[o + 3] = material
        scanned[o + 4] = open | on
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
 * its voxel's record, 1 if a ray along the baking direction reaches it
 * (0 if only other rays through the chunk do), and how far past each side
 * of its rectangle (minX, minY, maxX, maxY) it is grown to fill gaps (see
 * fillFaces).
 */
export const FACE = 11

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
 * Given the slice `detail` (0 for none), side faces are also grown to close
 * the gaps that open between slices (DESIGN.md, section 3): faces on the
 * near or far plane of voxels that go on into the next slice, including
 * ones only rays a little off the baking direction reach (marked as not
 * reached). They grow at most directionError · size / 2, so only voxels
 * within (|tan| + directionError) · size / 2 + 1 of the cell, less than a
 * cell width, are looked at: the cell and its eight neighbours.
 */
export function chunkFaces(
  surface: SliceSurface, x0: number, y0: number, tanX: number, tanY: number, detail = 0,
): ChunkFaces {
  const { depth, size, width: w, records } = surface
  const centre = sliceCentre(surface)
  const reach = detail > 0 ? directionError(detail) : 0
  const marginX = ((Math.abs(tanX) + reach) * size) / 2 + 1
  const marginY = ((Math.abs(tanY) + reach) * size) / 2 + 1
  const near = (x: number, y: number) =>
    x > x0 - 1 - marginX && x < x0 + w + marginX && y > y0 - 1 - marginY && y < y0 + w + marginY

  // A ray through the plane at p, from a camera at distance D ≥ size · detail,
  // has tangent σ = τc + (p − cell centre) / D, and the cell's centre ray τc is
  // within half a direction step of the baking direction. A face at depth z′
  // is drawn (σ − tan) · (z′ − centre) off. On the slice's near or far plane
  // (d = z′ − centre = −size / 2 or size / 2) that pulls the slice's edge
  // away from the next slice's when σ is farther from the screen centre
  // than tan, so the face grows back by that much, for the largest such
  // σ − tan over a face spanning [lo, hi] along an axis. Returns the growth
  // below and above.
  const perUnit = detail > 0 ? 1 / (size * detail) : 0
  const halfStep = detail > 0 ? directionStep(detail) / 2 : 0
  const grow = (tan: number, cellCentre: number, lo: number, hi: number, d0: number, d1: number): [number, number] => {
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
  const emit = (
    kind: number, reached: boolean, r: number, minX: number, minY: number, maxX: number, maxY: number,
    growLeft = 0, growBottom = 0, growRight = 0, growTop = 0,
  ) => {
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
    d[o + 6] = reached ? 1 : 0
    d[o + 7] = growLeft
    d[o + 8] = growBottom
    d[o + 9] = growRight
    d[o + 10] = growTop
    faces.minX = Math.min(faces.minX, minX - growLeft)
    faces.maxX = Math.max(faces.maxX, maxX + growRight)
    faces.minY = Math.min(faces.minY, minY - growBottom)
    faces.maxY = Math.max(faces.maxY, maxY + growTop)
  }

  // A side face is its voxel's edge swept one unit deep: a parallelogram.
  // It is drawn as its bounding rectangle, which covers a little more, never less.
  const [lowX, highX] = [Math.min(0, -tanX), Math.max(0, -tanX)]
  const [lowY, highY] = [Math.min(0, -tanY), Math.max(0, -tanY)]
  for (let z = depth + size - 1; z >= depth; z--) {
    // Baking shifts the plane z − 0.5 by (nearX, nearY), and each unit of depth by (−tanX, −tanY).
    const [nearX, nearY] = bake(0, 0, z - 0.5, tanX, tanY, centre)
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
      // Side faces' rectangles: the swept edge along their axis, the voxel across it.
      const [l, rt] = [left(x) + lowX, left(x) + 1 + highX]
      const [b, t] = [bottom(y) + lowY, bottom(y) + 1 + highY]
      // Only on a plane the voxel goes on past can a gap open.
      const d0 = open & ON_NEAR ? -size / 2 : 0
      const d1 = open & ON_FAR ? size / 2 : 0
      const crossing = perUnit > 0 && d0 !== d1
      const [growLeft, growRight] = crossing ? grow(tanX, cellX, l, rt, d0, d1) : [0, 0]
      const [growBottom, growTop] = crossing ? grow(tanY, cellY, b, t, d0, d1) : [0, 0]
      // Whether a ray along the baking direction reaches a face (it goes `towards`
      // along the axis), or, for a crossing face, some ray through the chunk may.
      const shows = (kind: number, tan: number, towards: number) =>
        open & (1 << kind) && (Math.sign(tan) === towards || (crossing && Math.sign(tan + towards * reach) === towards))
      for (const [kind, edge, towards] of [[LEFT, left(x), 1], [RIGHT, left(x) + 1, -1]]) {
        if (!shows(kind, tanX, towards)) continue
        emit(kind, Math.sign(tanX) === towards, r, edge + lowX, b, edge + highX, t, growLeft, growBottom, growRight, growTop)
      }
      for (const [kind, edge, towards] of [[BOTTOM, bottom(y), 1], [TOP, bottom(y) + 1, -1]]) {
        if (!shows(kind, tanY, towards)) continue
        emit(kind, Math.sign(tanY) === towards, r, l, edge + lowY, rt, edge + highY, growLeft, growBottom, growRight, growTop)
      }
    })
    eachVoxel((r, x, y, open) => {
      if (open & (1 << FRONT)) emit(FRONT, true, r, left(x), bottom(y), left(x) + 1, bottom(y) + 1)
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
 * there. Faces the baking direction reaches are painted in order.
 *
 * Then every face, grown as FACE records, is painted where nothing is yet,
 * nearest first. This closes the gaps between slices (DESIGN.md, section
 * 3) without changing what the chunk already shows. Returns how many faces
 * covered a pixel.
 */
export function fillFaces(
  faces: ChunkFaces, palette: Uint32Array,
  pixels: Uint32Array, width: number, height: number, originX: number, originY: number, scale: number,
): number {
  const { data } = faces
  // The first pixel whose centre is at or past u units from the origin.
  const pixel = (u: number) => Math.ceil(u * scale - 0.5)
  // Pixel rectangle of face f, grown (g = 1) or not (g = 0), clipped to the buffer.
  const rect = (f: number, g: number) => {
    const o = f * FACE
    return {
      from: Math.max(0, pixel(data[o] - g * data[o + 7] - originX)),
      top: Math.max(0, pixel(originY - data[o + 3] - g * data[o + 10])),
      to: Math.min(width, pixel(data[o + 2] + g * data[o + 9] - originX)),
      bottom: Math.min(height, pixel(originY - data[o + 1] + g * data[o + 8])),
    }
  }
  const covered = new Uint8Array(faces.count)
  for (let f = 0; f < faces.count; f++) {
    if (data[f * FACE + 6] === 0) continue
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
    const { from, top, to, bottom } = rect(f, 1)
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
