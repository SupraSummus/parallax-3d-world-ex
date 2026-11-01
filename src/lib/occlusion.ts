/**
 * Which parts of the screen nearer layers already cover, so chunks behind
 * them need not be drawn. See docs/architecture.md, section 4.
 */
import type { Chunk, Placement } from './renderer'
import { screenBox, screenRay, tangentBox, type Face, type ScreenBox, type TangentBox, type View } from './view'

/** Side of a coverage cell, in CSS pixels. */
const CELL = 16
/**
 * A box counts as covered only with this many covered CSS pixels around
 * it, so a small move does not uncover chunks right away.
 */
const MARGIN = 8

/**
 * The screen in cells of CELL pixels, each covered or not, for the face
 * being drawn. Each pixel shows one face (but for a hair at seams), so a
 * face only needs its own part of a cell covered, and cells outside it
 * count as covered. Conservative:
 * a cell is covered once every pixel of the face's part of it shows an
 * opaque pixel of a layer drawn so far. Faces come one by one, each with
 * its layers near to far.
 */
export class Coverage {
  private cols: number
  private rows: number
  private covered: Uint8Array
  // Per cell, by rows of cols + 1 (the last one a stop): itself if the
  // current face could still cover it, else towards the next such cell in
  // its row (see next()).
  private open: Int32Array
  // Per cell, for the current face: bounds of x / z and y / z of the face's
  // rays through it (minX, maxX, minY, maxY).
  private tangents: Float64Array
  private box: ReturnType<typeof screenBox> | null = null
  // Per cell, for the layer being covered: area of the plane under it
  // proven opaque so far.
  private area: Float64Array

  constructor(private view: View) {
    this.cols = Math.ceil(view.width / CELL)
    this.rows = Math.ceil(view.height / CELL)
    const cells = this.cols * this.rows
    this.covered = new Uint8Array(cells)
    this.open = new Int32Array((this.cols + 1) * this.rows)
    this.tangents = new Float64Array(cells * 4)
    this.area = new Float64Array(cells)
  }

  /** Starts a face; its layers follow, near to far. */
  setFace(face: Face) {
    const { view, cols, rows, tangents, open, covered } = this
    this.box = screenBox(view, face)
    // Rays through the cell corners, and which of the face's sides (bits of
    // PYRAMID_SIDES, see inFace) each is outside of.
    const rays = Array.from({ length: (cols + 1) * (rows + 1) }, (_, k) =>
      screenRay(view, face, (k % (cols + 1)) * CELL, Math.floor(k / (cols + 1)) * CELL))
    const outside = rays.map(({ x, y, z }) => (z < x + Math.SQRT2 * y ? 1 : 0) | (z < -x + Math.SQRT2 * y ? 2 : 0) |
      (z < x - Math.SQRT2 * y ? 4 : 0) | (z < -x - Math.SQRT2 * y ? 8 : 0))
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * (cols + 1) + i
        const c = j * cols + i
        const corners = [k, k + 1, k + cols + 2, k + cols + 1]
        let box: TangentBox | null = null
        // All corners outside one side: the cell is outside the face. All
        // inside: its tangents are extreme at its corners (ratios of linear
        // functions of the screen position). Otherwise clip.
        if ((outside[k] & outside[k + 1] & outside[k + cols + 1] & outside[k + cols + 2]) === 0) {
          if ((outside[k] | outside[k + 1] | outside[k + cols + 1] | outside[k + cols + 2]) === 0) {
            const xs = corners.map(n => rays[n].x / rays[n].z)
            const ys = corners.map(n => rays[n].y / rays[n].z)
            box = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
          } else {
            box = tangentBox(corners.map(n => rays[n]))
          }
        }
        if (box) [tangents[4 * c], tangents[4 * c + 1], tangents[4 * c + 2], tangents[4 * c + 3]] = [box.minX, box.maxX, box.minY, box.maxY]
        covered[c] = box ? 0 : 1
        open[k] = covered[c] ? k + 1 : k
      }
      open[j * (cols + 1) + cols] = j * (cols + 1) + cols
    }
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

  /** Whether a screen box, with MARGIN around it, is covered. */
  hides(box: ScreenBox): boolean {
    const [i0, i1, j0, j1] = this.cells(box, MARGIN)
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) if (!this.covered[j * this.cols + i]) return false
    }
    return true
  }

  /**
   * Adds what a layer of the current face draws opaque: its placements
   * (from the same aligned chunk grid, see chunkCell) on the plane
   * z = distance. `camera` is the camera's position in face coordinates.
   */
  cover(placements: Placement[], distance: number, cell: { width: number; height: number }, camera: { x: number; y: number }) {
    const { box: boxOf, cols, covered, tangents, area } = this
    if (!boxOf) throw new Error('setFace first')
    const touched: number[] = []
    for (const { chunk, x, y } of placements) {
      const { solid, scale } = chunk
      // The all-drawn blocks, clipped to the chunk's grid cell so pieces of
      // a screen cell from different chunks don't overlap.
      const cellLeft = chunk.i * cell.width - camera.x
      const cellBottom = chunk.j * cell.height - camera.y
      const left = Math.max(x + solid.left / scale, cellLeft)
      const right = Math.min(x + solid.right / scale, cellLeft + cell.width)
      const bottom = Math.max(y - solid.bottom / scale, cellBottom)
      const top = Math.min(y - solid.top / scale, cellBottom + cell.height)
      if (left >= right || bottom >= top) continue
      const box = boxOf(left, right, bottom, top, distance)
      if (!box) continue
      const [i0, i1, j0, j1] = this.cells(box, 0)
      for (let j = j0; j <= j1; j++) {
        for (let n = this.next(j * (cols + 1) + i0); n <= j * (cols + 1) + i1; n = this.next(n + 1)) {
          const k = n - j
          // The screen cell's part of the plane is within this rectangle.
          const l = Math.max(tangents[4 * k] * distance, left)
          const r = Math.min(tangents[4 * k + 1] * distance, right)
          const b = Math.max(tangents[4 * k + 2] * distance, bottom)
          const t = Math.min(tangents[4 * k + 3] * distance, top)
          if (l >= r || b >= t || !opaque(chunk, (l - x) * scale, (r - x) * scale, (y - t) * scale, (y - b) * scale)) continue
          if (area[k] === 0) touched.push(k)
          area[k] += (r - l) * (t - b)
        }
      }
    }
    // Covered if the opaque pieces add up to the whole rectangle.
    for (const k of touched) {
      const whole = (tangents[4 * k + 1] - tangents[4 * k]) * (tangents[4 * k + 3] - tangents[4 * k + 2]) * distance * distance
      if (area[k] >= whole * (1 - 1e-9)) {
        covered[k] = 1
        const n = k + Math.floor(k / cols)
        this.open[n] = n + 1
      }
      area[k] = 0
    }
  }

  /** The range of cells (i0, i1, j0, j1, inclusive) a box with `margin` around it overlaps, clamped to the screen. */
  private cells(box: ScreenBox, margin: number): [number, number, number, number] {
    const clamp = (v: number, n: number) => Math.min(n - 1, Math.max(0, Math.floor(v / CELL)))
    return [
      clamp(box.minX - margin, this.cols), clamp(box.maxX + margin, this.cols),
      clamp(box.minY - margin, this.rows), clamp(box.maxY + margin, this.rows),
    ]
  }
}

/** Side of a block of chunk pixels in Solid. */
const BLOCK = 4

/** Which blocks of BLOCK × BLOCK pixels of a chunk draw all their pixels. */
export interface Solid {
  /** 1 per such block, in rows of ceil(width / BLOCK) blocks. */
  blocks: Uint8Array
  /** Their bounds in pixels, [left, right) × [top, bottom); empty if there are none. */
  left: number
  right: number
  top: number
  bottom: number
}

/** The solid blocks of an image; a block reaching past its edge counts its pixels in the image. */
export function solidBlocks(pixels: Uint32Array, width: number, height: number): Solid {
  const cols = Math.ceil(width / BLOCK)
  const rows = Math.ceil(height / BLOCK)
  const blocks = new Uint8Array(cols * rows).fill(1)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[y * width + x] === 0) blocks[Math.floor(y / BLOCK) * cols + Math.floor(x / BLOCK)] = 0
    }
  }
  const solid = { blocks, left: width, right: 0, top: height, bottom: 0 }
  blocks.forEach((full, k) => {
    if (!full) return
    const [x, y] = [(k % cols) * BLOCK, Math.floor(k / cols) * BLOCK]
    solid.left = Math.min(solid.left, x)
    solid.right = Math.max(solid.right, Math.min(width, x + BLOCK))
    solid.top = Math.min(solid.top, y)
    solid.bottom = Math.max(solid.bottom, Math.min(height, y + BLOCK))
  })
  return solid
}

/**
 * Whether a chunk draws every pixel of the rectangle [left, right) ×
 * [top, bottom) of its image (pixel units, rows from the top), by whole
 * blocks. A pixel more on each side: minified, the texture is smoothed
 * over neighbours, and the compositor drops mostly empty results.
 */
function opaque({ solid: { blocks }, width, height }: Chunk, left: number, right: number, top: number, bottom: number): boolean {
  const cols = Math.ceil(width / BLOCK)
  const x0 = Math.floor(Math.max(0, Math.floor(left) - 1) / BLOCK)
  const x1 = Math.ceil(Math.min(width, Math.ceil(right) + 1) / BLOCK)
  const y0 = Math.floor(Math.max(0, Math.floor(top) - 1) / BLOCK)
  const y1 = Math.ceil(Math.min(height, Math.ceil(bottom) + 1) / BLOCK)
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) if (!blocks[y * cols + x]) return false
  }
  return true
}
