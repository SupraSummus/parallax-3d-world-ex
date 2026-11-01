/**
 * Baking whole chunks: from a chunk request to its pixels. Used by the
 * renderer directly (without workers) and inside bake workers, through the
 * message protocol below. No DOM.
 */
import { sliceSurface, chunkFaces, fillFaces, shadedPalette, type SliceSurface } from './bake'
import type { VoxelData } from './voxel-grid'

/**
 * A chunk to bake: corner (x, y) of the slice [depth, depth + size), seen
 * along (tanX, tanY, 1), with faces grown for rays up to `spread` off it
 * (see chunkFaces).
 */
export interface ChunkRequest {
  depth: number
  size: number
  x: number
  y: number
  tanX: number
  tanY: number
  spread: number
}

/** A baked chunk's pixels, cropped to what is drawn. */
export interface ChunkImage {
  /** Size in pixels; see originX/originY. */
  width: number
  height: number
  /** RGBA, rows top to bottom; transparent where nothing is drawn. */
  pixels: Uint32Array
  /** World x, y of the top-left pixel's corner. */
  originX: number
  originY: number
  /** Pixels per world unit (see renderScale). */
  scale: number
  /** Number of voxel faces drawn. */
  facesDrawn: number
}

// Pixels per world unit used when rasterising the nearest (size-1) slices.
// Chunks are rasterised camera-independently so they can be cached and
// reused as the camera moves; perspective scaling is applied when
// compositing.
const RENDER_SCALE = 10

/**
 * Chunk pixels per world unit for a slice of `size`: 24 / size, between 2
 * and RENDER_SCALE. A slice of size s ≥ 2 lies at distance ≥ s · detail,
 * where a voxel is at most focal / (s · detail) screen pixels, about 24 / s
 * with the defaults; finer chunks would not show. Other settings just
 * scale the chunks on screen.
 */
function renderScale(size: number): number {
  return Math.max(2, Math.min(RENDER_SCALE, Math.floor(24 / size)))
}

// Slice surfaces kept for baking more chunks of the same slice, least recently used dropped first.
const MAX_SURFACES = 64

/** Bakes chunks of one world, keeping the surfaces of recently used slices. */
export class ChunkBaker {
  private grid: VoxelData
  private palette: Uint32Array
  // Keyed by `depth:size`; insertion order is LRU order.
  private surfaces = new Map<string, SliceSurface>()

  constructor(grid: VoxelData) {
    this.grid = grid
    this.palette = shadedPalette(grid.materials)
  }

  /**
   * Rasterises one chunk: the slice baked along (tanX, tanY, 1) onto its
   * centre plane (see bake.ts), clipped to the chunk's cell and cropped to
   * what is drawn there. A chunk no face reaches has no pixels.
   */
  bake({ depth, size, x: x0, y: y0, tanX, tanY, spread }: ChunkRequest): ChunkImage {
    const surface = this.surface(depth, size)
    const faces = chunkFaces(surface, x0, y0, tanX, tanY, spread)

    // Drawn extent, clipped to the cell [x0 - 0.5, x0 + w - 0.5) × [y0 - 0.5, y0 + w - 0.5).
    const w = surface.width
    const minX = Math.max(faces.minX, x0 - 0.5)
    const maxX = Math.min(faces.maxX, x0 + w - 0.5)
    const minY = Math.max(faces.minY, y0 - 0.5)
    const maxY = Math.min(faces.maxY, y0 + w - 0.5)

    const scale = renderScale(size)
    const empty = maxX <= minX || maxY <= minY
    const width = empty ? 0 : Math.ceil((maxX - minX) * scale)
    const height = empty ? 0 : Math.ceil((maxY - minY) * scale)
    const pixels = new Uint32Array(width * height)
    // Without antialiasing: magnified many times on screen, a soft 1-pixel
    // edge would become a wide blur.
    const facesDrawn = fillFaces(faces, this.palette, pixels, width, height, minX, maxY, scale)
    return { width, height, pixels, originX: minX, originY: maxY, scale, facesDrawn }
  }

  private surface(depth: number, size: number): SliceSurface {
    const key = `${String(depth)}:${String(size)}`
    let surface = this.surfaces.get(key)
    if (surface) this.surfaces.delete(key)
    else surface = sliceSurface(this.grid, depth, size)
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
      post({ generation, request, image }, [image.pixels.buffer])
    }
  }
}
