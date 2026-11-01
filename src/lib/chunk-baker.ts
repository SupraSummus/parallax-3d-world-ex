/**
 * Baking whole chunks: from a chunk request to its pixels. Used by the
 * renderer directly (without workers) and inside bake workers, through the
 * message protocol below. No DOM.
 */
import { cellSurface, chunkFaces, fillFaces, shadedPalette } from './bake'
import { chunkCell } from './slice-selection'
import { solidBlocks, type Solid } from './occlusion'
import { FACES, type Face } from './view'
import type { VoxelData } from './voxel-grid'

/**
 * A chunk to bake: cell (i, j) (see chunkCell) of the slice
 * [depth, depth + size) of a face (by name, see FACES), seen along
 * (tanX, tanY, 1), in the face's coordinates, with faces grown to fill
 * gaps for slices of `fillDetail` (0 for none; see chunkFaces).
 */
export interface ChunkRequest {
  face: string
  depth: number
  size: number
  i: number
  j: number
  tanX: number
  tanY: number
  fillDetail: number
}

/** A baked chunk's pixels, cropped to what is drawn. */
export interface ChunkImage {
  /** Size in pixels; see originX/originY. */
  width: number
  height: number
  /** RGBA, rows top to bottom; transparent where nothing is drawn. */
  pixels: Uint32Array
  /** Which blocks of pixels are all drawn, for finding what the chunk hides. */
  solid: Solid
  /** x, y of the top-left pixel's corner, in face coordinates. */
  originX: number
  originY: number
  /** Pixels per world unit (see renderScale). */
  scale: number
  /** Number of voxel faces drawn. */
  facesDrawn: number
}

// Pixels per unit used when rasterising the nearest slices: 20 pixels
// across a voxel, 2 units wide, so that rhombi magnified near the camera
// keep their slanted edges. Chunks are rasterised camera-independently so
// they can be cached and reused as the camera moves; perspective scaling
// is applied when compositing.
const RENDER_SCALE = 10

/**
 * Chunk pixels per unit for a slice of `size`: 40 / (size + 1), between 1
 * (2 pixels across a voxel) and RENDER_SCALE. A slice of size s lies at
 * distance ≥ (s + 1) · detail · LAYER, where a unit is at most
 * focal / ((s + 1) · detail · LAYER) screen pixels, about 40 / (s + 1) with
 * the defaults; finer chunks would not show. Other settings just scale the
 * chunks on screen.
 */
function renderScale(size: number): number {
  return Math.max(1, Math.min(RENDER_SCALE, Math.floor(40 / (size + 1))))
}

// Cell surfaces kept for baking the same cell along other directions,
// least recently used dropped first.
const MAX_SURFACES = 1024

/**
 * Bakes chunks of one world, keeping the surfaces of recently used cells
 * and the palette of each face baked so far.
 */
export class ChunkBaker {
  private grid: VoxelData
  private faces = new Map<string, { axes: Face; palette: Uint32Array }>()
  // Keyed by `face:depth:size:i:j`; insertion order is LRU order.
  private surfaces = new Map<string, Int32Array>()

  constructor(grid: VoxelData) {
    this.grid = grid
  }

  /**
   * Rasterises one chunk: the slice baked along (tanX, tanY, 1) onto its
   * centre plane (see bake.ts), clipped to the chunk's cell and cropped to
   * what is drawn there. A chunk no face reaches has no pixels.
   */
  bake({ face, depth, size, i, j, tanX, tanY, fillDetail }: ChunkRequest): ChunkImage {
    const { axes, palette } = this.face(face)
    const faces = chunkFaces({ depth, size }, this.surface(axes, depth, size, i, j), i, j, tanX, tanY, fillDetail)

    // Drawn extent, clipped to the cell.
    const { width: w, height: h } = chunkCell(size)
    const minX = Math.max(faces.minX, i * w)
    const maxX = Math.min(faces.maxX, (i + 1) * w)
    const minY = Math.max(faces.minY, j * h)
    const maxY = Math.min(faces.maxY, (j + 1) * h)

    const scale = renderScale(size)
    const empty = maxX <= minX || maxY <= minY
    const width = empty ? 0 : Math.ceil((maxX - minX) * scale)
    const height = empty ? 0 : Math.ceil((maxY - minY) * scale)
    const pixels = new Uint32Array(width * height)
    // Without antialiasing: magnified many times on screen, a soft 1-pixel
    // edge would become a wide blur.
    const facesDrawn = fillFaces(faces, palette, pixels, width, height, minX, maxY, scale)
    return { width, height, pixels, solid: solidBlocks(pixels, width, height), originX: minX, originY: maxY, scale, facesDrawn }
  }

  private face(name: string): { axes: Face; palette: Uint32Array } {
    let face = this.faces.get(name)
    if (!face) {
      const axes = FACES.find(f => f.name === name)
      if (!axes) throw new Error(`no face ${name}`)
      face = { axes, palette: shadedPalette(this.grid.materials, axes.lattice) }
      this.faces.set(name, face)
    }
    return face
  }

  private surface(face: Face, depth: number, size: number, i: number, j: number): Int32Array {
    const key = `${face.name}:${String(depth)}:${String(size)}:${String(i)}:${String(j)}`
    let surface = this.surfaces.get(key)
    if (surface) this.surfaces.delete(key)
    else surface = cellSurface(this.grid, face.lattice, depth, size, i, j)
    this.surfaces.set(key, surface)
    for (const old of this.surfaces.keys()) {
      if (this.surfaces.size <= MAX_SURFACES) break
      this.surfaces.delete(old)
    }
    return surface
  }
}

/**
 * Messages to a bake worker: a new world, or a chunk to bake. `generation`
 * numbers worlds; the answer echoes it.
 */
export type BakeMessage =
  | { type: 'world'; grid: VoxelData }
  | { type: 'bake'; generation: number; request: ChunkRequest }

/** A bake worker's answer to a `bake` message. */
export interface BakeResult {
  generation: number
  request: ChunkRequest
  image: ChunkImage
}

/**
 * A bake worker's message handler: bakes each requested chunk and posts
 * the result, handing over its pixel buffer.
 */
export function bakeHandler(post: (result: BakeResult, transfer: Transferable[]) => void): (message: BakeMessage) => void {
  let baker: ChunkBaker | null = null
  return message => {
    if (message.type === 'world') {
      baker = new ChunkBaker(message.grid)
    } else if (baker) {
      const { generation, request } = message
      const image = baker.bake(request)
      post({ generation, request, image }, [image.pixels.buffer, image.solid.blocks.buffer])
    }
  }
}
