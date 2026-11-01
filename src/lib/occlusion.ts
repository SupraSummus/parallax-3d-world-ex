/**
 * Which parts of the screen nearer layers already cover, so chunks behind
 * them need not be drawn. See docs/architecture.md, section 4.
 */
import type { Chunk, Placement } from './renderer'
import { faceBasis, onScreen, screenBox, screenRay, tangentBox, type Face, type ScreenBox, type View } from './view'
import type { Vec3 } from './world'

/** Side of a coverage cell, in CSS pixels. */
const CELL = 16
/** Side of a sub-block of a cell, in CSS pixels: a cell has SUBS × SUBS of them. */
const SUB = 4
const SUBS = CELL / SUB
const SHIFT = Math.log2(SUBS)
const MASK = SUBS - 1
/** A cell's bits with all its sub-blocks covered. */
const FULL = (1 << (SUBS * SUBS)) - 1
/** Masks of a cell's bits: ROWS[a][b] has bit 0 of rows a to b, COLUMNS[a][b] the bits of columns a to b of row 0. */
const ROWS = Array.from({ length: SUBS }, (_, a) => Array.from({ length: SUBS }, (_, b) => {
  let mask = 0
  for (let r = a; r <= b; r++) mask |= 1 << (r * SUBS)
  return mask
}))
const COLUMNS = Array.from({ length: SUBS }, (_, a) => Array.from({ length: SUBS }, (_, b) => ((1 << (b + 1)) - 1) & ~((1 << a) - 1)))
/**
 * A box counts as covered only with this many covered CSS pixels around
 * it, so a small move does not uncover chunks right away.
 */
const MARGIN = 8

/** What Coverage keeps of a face per view: see Coverage.shape. */
interface Shape {
  key: string
  tangents: Float64Array<ArrayBuffer>
  cellTangents: Float64Array<ArrayBuffer>
  outside: Uint16Array<ArrayBuffer>
}

/**
 * The screen in cells of CELL pixels, each covered or not, for the face
 * being drawn. Each pixel shows one face (but for a hair at seams), so a
 * face only needs its own part of a cell covered, and cells outside it
 * count as covered. Conservative: a cell is covered once each of its
 * sub-blocks of SUB pixels, the face's part of it, is covered by one layer
 * drawn so far (by opaque pixels of that layer's chunks); different
 * sub-blocks may be covered by different layers. Faces come one by one,
 * each with its layers near to far.
 */
export class Coverage {
  private view!: View
  private cols = 0
  private rows = 0
  // Sub-blocks across and down: cols · SUBS, rows · SUBS.
  private subCols = 0
  private subRows = 0
  private covered = new Uint8Array(0)
  // Per cell, a bit per sub-block (row by row) the current face covers, or that is outside it.
  private bits = new Uint16Array(0)
  // Per cell, by rows of cols + 1 (the last one a stop): itself if the
  // current face could still cover it, else towards the next such cell in
  // its row (see next()).
  private open = new Int32Array(0)
  // Per sub-block, for the current face: bounds of x / z and y / z of the
  // face's rays through it (minX, maxX, minY, maxY).
  private tangents = new Float64Array(0)
  // Per face, its tangents and the sub-blocks outside it for the latest view it was seen through.
  private shapes = new Map<string, Shape>()
  // The same per cell wholly inside the face; NaN for others.
  private cellTangents = new Float64Array(0)
  // Tangents (x / z, y / z) of the rays through the sub-blocks' corners, and the face's sides each is outside of.
  private rays = new Float64Array(0)
  private outside = new Uint8Array(0)
  private box: ReturnType<typeof screenBox> | null = null
  // Per sub-block, for the layer being covered: area of the plane under it
  // proven opaque so far, and the sub-blocks with some.
  private area = new Float64Array(0)
  private touched: number[] = []

  constructor(view: View) {
    this.setView(view)
  }

  /** Starts a frame seen through `view`; buffers are kept while its size stays. */
  setView(view: View) {
    this.view = view
    const cols = Math.ceil(view.width / CELL)
    const rows = Math.ceil(view.height / CELL)
    if (cols === this.cols && rows === this.rows) return
    this.cols = cols
    this.rows = rows
    this.subCols = cols * SUBS
    this.subRows = rows * SUBS
    const cells = cols * rows
    const subs = this.subCols * this.subRows
    this.shapes.clear()
    this.covered = new Uint8Array(cells)
    this.bits = new Uint16Array(cells)
    this.open = new Int32Array((cols + 1) * rows)
    this.area = new Float64Array(subs)
    const corners = (this.subCols + 1) * (this.subRows + 1)
    this.rays = new Float64Array(corners * 2)
    this.outside = new Uint8Array(corners)
  }

  /** Starts a face; its layers follow, near to far. */
  setFace(face: Face) {
    const { view, cols, rows, open, covered, bits } = this
    this.box = screenBox(view, face)
    // What depends only on the view and the face is kept while they stay (moving, not turning).
    const key = [view.orientation.yaw, view.orientation.pitch, view.width, view.height, view.focal].join()
    let shape = this.shapes.get(face.name)
    if (shape?.key !== key) {
      shape = this.shape(face, key)
      this.shapes.set(face.name, shape)
    }
    this.tangents = shape.tangents
    this.cellTangents = shape.cellTangents
    bits.set(shape.outside)
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const c = j * cols + i
        const k = j * (cols + 1) + i
        covered[c] = bits[c] === FULL ? 1 : 0
        open[k] = covered[c] ? k + 1 : k
      }
      open[j * (cols + 1) + cols] = j * (cols + 1) + cols
    }
  }

  /** The tangents of a face's rays through each sub-block and cell, and per cell its sub-blocks outside the face. */
  private shape(face: Face, key: string): Shape {
    const { view, cols, rows, subCols, subRows, rays, outside } = this
    const tangents = new Float64Array(subCols * subRows * 4)
    const cellTangents = new Float64Array(cols * rows * 4)
    const bits = new Uint16Array(cols * rows)
    // Tangents of the rays through the sub-block corners, and which of the
    // face's sides (see inFace) each is outside of.
    const { right, up, forward } = faceBasis(face, view.orientation)
    const corners = subCols + 1
    for (let n = 0; n < corners * (subRows + 1); n++) {
      const a = (n % corners) * SUB - view.width / 2
      const b = view.height / 2 - Math.floor(n / corners) * SUB
      const x = forward.x * view.focal + right.x * a + up.x * b
      const y = forward.y * view.focal + right.y * a + up.y * b
      const z = forward.z * view.focal + right.z * a + up.z * b
      rays[2 * n] = x / z
      rays[2 * n + 1] = y / z
      outside[n] = (z < x + Math.SQRT2 * y ? 1 : 0) | (z < -x + Math.SQRT2 * y ? 2 : 0) |
        (z < x - Math.SQRT2 * y ? 4 : 0) | (z < -x - Math.SQRT2 * y ? 8 : 0)
    }
    // The bounds of a rectangle's tangents, of corners k (top-left) to k + d + corners · e, all inside the face:
    // its tangents are extreme at its corners (ratios of linear functions of the screen position).
    const bounds = (into: Float64Array, at: number, k: number, d: number) => {
      const q = [k, k + d, k + d * corners, k + d * (corners + 1)]
      into[at] = Math.min(rays[2 * q[0]], rays[2 * q[1]], rays[2 * q[2]], rays[2 * q[3]])
      into[at + 1] = Math.max(rays[2 * q[0]], rays[2 * q[1]], rays[2 * q[2]], rays[2 * q[3]])
      into[at + 2] = Math.min(rays[2 * q[0] + 1], rays[2 * q[1] + 1], rays[2 * q[2] + 1], rays[2 * q[3] + 1])
      into[at + 3] = Math.max(rays[2 * q[0] + 1], rays[2 * q[1] + 1], rays[2 * q[2] + 1], rays[2 * q[3] + 1])
    }
    const screenRayAt = (n: number): Vec3 => screenRay(view, face, (n % corners) * SUB, Math.floor(n / corners) * SUB)
    for (let sj = 0; sj < subRows; sj++) {
      for (let si = 0; si < subCols; si++) {
        const k = sj * corners + si
        const s = sj * subCols + si
        const [o0, o1, o2, o3] = [outside[k], outside[k + 1], outside[k + corners], outside[k + corners + 1]]
        // All corners inside: bounded by its corners; all outside one side: outside the face; otherwise clip.
        if ((o0 | o1 | o2 | o3) === 0) {
          bounds(tangents, 4 * s, k, 1)
          continue
        }
        const box = (o0 & o1 & o2 & o3) === 0 ? tangentBox([k, k + 1, k + corners + 1, k + corners].map(screenRayAt)) : null
        if (box) {
          tangents.set([box.minX, box.maxX, box.minY, box.maxY], 4 * s)
        } else {
          bits[(sj >> SHIFT) * cols + (si >> SHIFT)] |= 1 << ((sj & MASK) * SUBS + (si & MASK))
        }
      }
    }
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const c = j * cols + i
        // A cell wholly inside the face, for covering it at once (NaN if not).
        const corner = j * SUBS * corners + i * SUBS
        let inside = true
        for (let e = 0; e <= SUBS && inside; e += SUBS) {
          for (let d = 0; d <= SUBS; d += SUBS) if (outside[corner + e * corners + d]) inside = false
        }
        if (inside) bounds(cellTangents, 4 * c, corner, SUBS)
        else cellTangents[4 * c] = NaN
      }
    }
    return { key, tangents, cellTangents, outside: bits }
  }

  /** The first cell from k (by rows of cols + 1) the current face could still cover, or the row's stop. */
  private next(k: number): number {
    const { open } = this
    while (open[k] !== k) {
      open[k] = open[open[k]]
      k = open[k]
    }
    return k
  }

  /** Whether a screen box, with MARGIN around it, lies on covered sub-blocks. */
  hides(box: ScreenBox): boolean {
    const { cols, covered, bits } = this
    const [si0, si1, sj0, sj1] = this.cells(box, MARGIN, SUB, this.subCols, this.subRows)
    for (let j = sj0 >> SHIFT; j <= sj1 >> SHIFT; j++) {
      // The cell's rows of sub-blocks in the box, as a mask of a column of them.
      const rows = ROWS[Math.max(sj0 - j * SUBS, 0)][Math.min(sj1 - j * SUBS, SUBS - 1)]
      for (let i = si0 >> SHIFT; i <= si1 >> SHIFT; i++) {
        const c = j * cols + i
        if (covered[c]) continue
        const mask = rows * COLUMNS[Math.max(si0 - i * SUBS, 0)][Math.min(si1 - i * SUBS, SUBS - 1)]
        if ((bits[c] & mask) !== mask) return false
      }
    }
    return true
  }

  /**
   * Whether a chunk placed at (x, y) on the plane z = distance (see
   * Placement) is hidden: each tile of its image with a pixel drawn (see
   * drawnTiles) is hidden (see hides) or off screen.
   */
  hidesChunk(chunk: Chunk, x: number, y: number, distance: number): boolean {
    const { box: boxOf, view } = this
    if (!boxOf) throw new Error('setFace first')
    const tiles = drawnTiles(chunk)
    for (let t = 0; t < tiles.length; t += 4) {
      if (tiles[t] >= tiles[t + 1]) continue
      const box = boxOf(x + tiles[t] / chunk.scale, x + tiles[t + 1] / chunk.scale, y - tiles[t + 3] / chunk.scale, y - tiles[t + 2] / chunk.scale, distance)
      if (onScreen(view, box) && !this.hides(box)) return false
    }
    return true
  }

  /**
   * Adds what a layer of the current face draws opaque: its placements
   * (from the same aligned chunk grid, see chunkCell) on the plane
   * z = distance. `camera` is the camera's position in face coordinates.
   */
  cover(placements: Placement[], distance: number, cell: { width: number; height: number }, camera: { x: number; y: number }) {
    const { box: boxOf, cols, subCols, bits, covered, open, tangents, cellTangents, area, touched } = this
    if (!boxOf) throw new Error('setFace first')
    for (const { chunk, x, y } of placements) {
      const { solid, scale, width, height } = chunk
      const { blocks } = solid
      const blockCols = Math.ceil(width / BLOCK)
      // The all-drawn blocks, clipped to the chunk's grid cell so pieces of
      // a sub-block from different chunks don't overlap.
      const cellLeft = chunk.i * cell.width - camera.x
      const cellBottom = chunk.j * cell.height - camera.y
      const left = Math.max(x + solid.left / scale, cellLeft)
      const right = Math.min(x + solid.right / scale, cellLeft + cell.width)
      const bottom = Math.max(y - solid.bottom / scale, cellBottom)
      const top = Math.min(y - solid.top / scale, cellBottom + cell.height)
      if (left >= right || bottom >= top) continue
      const box = boxOf(left, right, bottom, top, distance)
      if (!box) continue
      // Whether the blocks under the plane's rectangle [l, r] × [b, t], with a pixel
      // around (minified, the texture is smoothed over neighbours), are all solid
      // (`all`), or some are.
      const test = (l: number, r: number, b: number, t: number, all: boolean) => {
        const x0 = (Math.max(0, Math.floor((l - x) * scale) - 1) / BLOCK) | 0
        const x1 = Math.ceil(Math.min(width, Math.ceil((r - x) * scale) + 1) / BLOCK)
        const y0 = (Math.max(0, Math.floor((y - t) * scale) - 1) / BLOCK) | 0
        const y1 = Math.ceil(Math.min(height, Math.ceil((y - b) * scale) + 1) / BLOCK)
        for (let by = y0; by < y1; by++) {
          for (let k = by * blockCols + x0, end = by * blockCols + x1; k < end; k++) {
            if (((blocks[k] & SOLID) !== 0) !== all) return !all
          }
        }
        return all
      }
      const [si0, si1, sj0, sj1] = this.cells(box, 0, SUB, subCols, this.subRows)
      for (let j = sj0 >> SHIFT; j <= sj1 >> SHIFT; j++) {
        const sjFrom = Math.max(sj0, j * SUBS)
        const sjTo = Math.min(sj1, j * SUBS + SUBS - 1)
        for (let n = this.next(j * (cols + 1) + (si0 >> SHIFT)); n <= j * (cols + 1) + (si1 >> SHIFT); n = this.next(n + 1)) {
          const c = n - j
          const i = c - j * cols
          // A cell (wholly in the face) this chunk alone covers is covered at once,
          // and its sub-blocks are not looked at if the chunk has no solid block under it.
          const cl = cellTangents[4 * c] * distance
          if (cl === cl) {
            const cr = cellTangents[4 * c + 1] * distance
            const cb = cellTangents[4 * c + 2] * distance
            const ct = cellTangents[4 * c + 3] * distance
            if (cl >= left && cr <= right && cb >= bottom && ct <= top && test(cl, cr, cb, ct, true)) {
              bits[c] = FULL
              covered[c] = 1
              open[n] = n + 1
              continue
            }
            if (!test(Math.max(cl, left), Math.min(cr, right), Math.max(cb, bottom), Math.min(ct, top), false)) continue
          }
          const done = bits[c]
          const siFrom = Math.max(si0, i * SUBS)
          const siTo = Math.min(si1, i * SUBS + SUBS - 1)
          for (let sj = sjFrom; sj <= sjTo; sj++) {
            for (let si = siFrom; si <= siTo; si++) {
              if (done & (1 << ((sj & MASK) * SUBS + (si & MASK)))) continue
              const s = sj * subCols + si
              // The sub-block's part of the plane is within this rectangle.
              const l = Math.max(tangents[4 * s] * distance, left)
              const r = Math.min(tangents[4 * s + 1] * distance, right)
              const b = Math.max(tangents[4 * s + 2] * distance, bottom)
              const t = Math.min(tangents[4 * s + 3] * distance, top)
              if (l >= r || b >= t || !test(l, r, b, t, true)) continue
              if (area[s] === 0) touched.push(s)
              area[s] += (r - l) * (t - b)
            }
          }
        }
      }
    }
    // Covered if the opaque pieces add up to the whole rectangle.
    for (const s of touched) {
      const whole = (tangents[4 * s + 1] - tangents[4 * s]) * (tangents[4 * s + 3] - tangents[4 * s + 2]) * distance * distance
      if (area[s] >= whole * (1 - 1e-9)) {
        const si = s % subCols
        const sj = (s - si) / subCols
        const c = (sj >> SHIFT) * cols + (si >> SHIFT)
        bits[c] |= 1 << ((sj & MASK) * SUBS + (si & MASK))
        if (bits[c] === FULL) {
          covered[c] = 1
          const n = c + Math.floor(c / cols)
          open[n] = n + 1
        }
      }
      area[s] = 0
    }
    touched.length = 0
  }

  /** The range of squares of `side` pixels (i0, i1, j0, j1, inclusive) a box with `margin` around it overlaps, clamped to cols × rows. */
  private cells(box: ScreenBox, margin: number, side: number, cols: number, rows: number): [number, number, number, number] {
    const clamp = (v: number, n: number) => Math.min(n - 1, Math.max(0, Math.floor(v / side)))
    return [
      clamp(box.minX - margin, cols), clamp(box.maxX + margin, cols),
      clamp(box.minY - margin, rows), clamp(box.maxY + margin, rows),
    ]
  }
}

/** Side of a block of chunk pixels in Solid (BLOCK in bake/src/fill.rs). */
const BLOCK = 4
/** A block's bits in Solid: all its pixels drawn, some drawn (SOLID and DRAWN in bake/src/fill.rs). */
const SOLID = 1
const DRAWN = 2

/** Which blocks of BLOCK × BLOCK pixels of a chunk draw all their pixels, and which some. */
export interface Solid {
  /** A byte of bits (SOLID, DRAWN) per such block, in rows of ceil(width / BLOCK) blocks. */
  blocks: Uint8Array
  /** Bounds of the solid blocks in pixels, [left, right) × [top, bottom); empty if there are none. */
  left: number
  right: number
  top: number
  bottom: number
}

/** Tiles across and down a chunk's image in drawnTiles. */
const TILES = 4

const tilesOf = new WeakMap<Solid, Int32Array>()

/**
 * A chunk's image cut into TILES × TILES tiles of whole blocks: per tile,
 * the bounds in pixels (left, right, top, bottom) of its blocks with a
 * pixel drawn, left ≥ right if none. Found on first use.
 */
function drawnTiles({ solid, width, height }: Chunk): Int32Array {
  let tiles = tilesOf.get(solid)
  if (tiles) return tiles
  tiles = new Int32Array(TILES * TILES * 4)
  const cols = Math.ceil(width / BLOCK)
  const rows = Math.ceil(height / BLOCK)
  for (let t = 0; t < TILES * TILES; t++) [tiles[4 * t], tiles[4 * t + 1], tiles[4 * t + 2], tiles[4 * t + 3]] = [width, 0, height, 0]
  for (let by = 0; by < rows; by++) {
    const ty = Math.floor((by * TILES) / rows)
    for (let bx = 0; bx < cols; bx++) {
      if (!(solid.blocks[by * cols + bx] & DRAWN)) continue
      const t = 4 * (ty * TILES + Math.floor((bx * TILES) / cols))
      tiles[t] = Math.min(tiles[t], bx * BLOCK)
      tiles[t + 1] = Math.max(tiles[t + 1], Math.min(width, (bx + 1) * BLOCK))
      tiles[t + 2] = Math.min(tiles[t + 2], by * BLOCK)
      tiles[t + 3] = Math.max(tiles[t + 3], Math.min(height, (by + 1) * BLOCK))
    }
  }
  tilesOf.set(solid, tiles)
  return tiles
}
