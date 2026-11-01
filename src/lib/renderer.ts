import { selectSlices, leakFreeDetail, directionStep, nearestDirection, sliceCentre, chunkWidth } from './slice-selection'
import { ChunkBaker, type ChunkImage, type ChunkRequest } from './chunk-baker'
import { World, type Vec3, type WorldType } from './world'
import type { VoxelData } from './voxel-grid'
import { MAX_VIEW_TANGENT, focalLength, rectangleTest, turn, viewTangents, type Orientation, type View } from './view'

export type Camera = Vec3

/** A rasterised, aligned square piece of a slice (see chunkWidth). */
export interface Chunk extends ChunkImage {
  /** Aligned corner: the chunk shows voxels with x in [x, x + width), y likewise. */
  x: number
  y: number
  /**
   * Baking direction (tangents): the chunk is the parallel projection of
   * its slice along (tanX, tanY, 1) onto the slice's centre plane.
   */
  tanX: number
  tanY: number
}

/**
 * A chunk in a frame: x, y of its top-left corner on its layer's plane,
 * relative to the camera, in world units. It spans chunk.width /
 * chunk.scale to the right and chunk.height / chunk.scale down.
 */
export interface Placement {
  chunk: Chunk
  x: number
  y: number
}

/**
 * What to draw, seen through `View` (see projector() in view.ts). Layers go
 * near to far; nearer ones hide what is behind them. A layer is the plane
 * `distance` ahead of the camera along +z (its slice's centre). `fog` is
 * the share of the horizon colour mixed into a layer's pixels, and into
 * the sky where no layer is drawn.
 */
export interface Frame extends View {
  fog: number
  layers: { distance: number; placements: Placement[]; fog: number }[]
}

export interface Layer {
  /** First integer z of the slice. */
  depth: number
  /** Thickness in z units; the slice holds voxels with z in [depth, depth + size). */
  size: number
  /** Number of voxels in the slice (most are hidden behind nearer ones). */
  voxelCount: number
  /** Non-empty chunks in view in the most recent render (some may stand in for chunks still baking). */
  chunks: Chunk[]
  visible: boolean
}

export interface UpdateStats {
  renderTime: number
  /** Distance / max slice thickness, from the leak tolerance (see leakFreeDetail). */
  detail: number
  layerCount: number
  /** Non-empty chunks in view. */
  chunkCount: number
  chunksReused: number
  /** Chunks in view shown for the first time since they were baked. */
  chunksRegenerated: number
  /** Chunks in view still baking (with a Bakery); an older bake of the same cell, if any, stands in. */
  chunksPending: number
  /** Voxel faces drawn into chunks baked since the previous render (including any whose content turned out to be off screen). */
  voxelsRendered: number
  /** Percentage of chunks in view served from the cache. */
  cacheEfficiency: number
  /** Pixels of all cached chunks, in view or not. */
  cachedPixels: number
}

export interface SessionStats {
  totalUpdates: number
  totalRenderTime: number
  totalChunksRegenerated: number
  totalVoxelsRendered: number
  averageCacheEfficiency: number
  lastUpdate: UpdateStats | null
}

// Field of view across the longer viewport side, in degrees (see focalLength).
export const DEFAULT_FOV = 90
export const MIN_FOV = 5
export const MAX_FOV = 120

// How many screen pixels of geometry that perspective would hide may show
// through the gaps between slices. Larger means thicker slices, fewer layers.
export const DEFAULT_MAX_LEAK = 16
export const MIN_MAX_LEAK = 1
export const MAX_MAX_LEAK = 64

// Visible depth range, relative to the camera: from NEAR_DEPTH to the render
// distance.
const NEAR_DEPTH = 1
export const DEFAULT_RENDER_DISTANCE = 200
export const MIN_RENDER_DISTANCE = 20
export const MAX_RENDER_DISTANCE = 400

// Slices and chunks outside the view are kept so that moving back reuses
// them, up to these caps. What is in view is never evicted.
const MAX_CACHED_SLICES = 64
const MAX_HIDDEN_CHUNK_PIXELS = 32_000_000

// Exponential distance fog towards the horizon colour: at viewing distance d
// a voxel keeps exp(-d / fogDistance) of its own colour. The fog distance
// scales with the render distance so the far cut-off stays hazy.
export const FOG_PER_RENDER_DISTANCE = 0.7

function sliceKey(depth: number, size: number): string {
  return `${String(depth)}:${String(size)}`
}

/** A cached slice and the chunks baked so far. */
interface Slice {
  layer: Layer
  /** Chunk width, see chunkWidth. */
  width: number
  /** Keyed by chunkKey. */
  chunks: Map<string, Chunk>
  /** The most recently baked chunk of each cell (keyed by cellKey), shown while the one wanted is baking. */
  latest: Map<string, Chunk>
}

function cellKey(x: number, y: number): string {
  return `${String(x)},${String(y)}`
}

function chunkKey(x: number, y: number, tanX: number, tanY: number): string {
  return `${cellKey(x, y)},${String(tanX)},${String(tanY)}`
}

/**
 * Bakes chunks off the main thread (see WorkerBakery). The renderer lists
 * the chunks it is missing on every render; each baked one comes back
 * through the callback given to connect().
 */
export interface Bakery {
  connect(deliver: (request: ChunkRequest, image: ChunkImage) => void): void
  /** Replaces the world; chunks of the previous one are no longer delivered. */
  setWorld(grid: VoxelData): void
  /** The chunks to bake, most wanted first. Replaces the previous list. */
  want(requests: ChunkRequest[]): void
}

export interface RendererOptions {
  /** Where chunks are baked. Without one, render() bakes every missing chunk itself before returning. */
  bakery?: Bakery
  /** Called whenever the bakery delivers chunks; render() again to show them. */
  onBaked?: () => void
}

/**
 * Renders a World as a stack of flat, cached slices, each split into chunks
 * so that only what is in view is rasterised. render() returns where each
 * chunk goes on screen; drawing it is the compositor's job. See DESIGN.md
 * for the slicing and caching scheme.
 */
export class ParallaxRenderer {
  private world: World
  private camera: Camera
  private orientation: Orientation = { yaw: 0, pitch: 0 }
  private fov = DEFAULT_FOV
  private maxLeak = DEFAULT_MAX_LEAK
  private renderDistance = DEFAULT_RENDER_DISTANCE
  private width = 0
  private height = 0

  // Keyed by sliceKey(depth, size). Map insertion order doubles as LRU order
  // (oldest first).
  private slices = new Map<string, Slice>()
  // Slices of the most recent render, near to far.
  private visibleSlices: Slice[] = []
  // Chunks of the most recent render.
  private inView = new Set<Chunk>()

  private bakery: Bakery | null
  private onBaked: () => void
  // Bakes on the main thread when there is no bakery.
  private baker: ChunkBaker | null = null
  // Baked but not shown yet: counted as regenerated when first shown.
  private fresh = new WeakSet<Chunk>()
  // Faces baked since the last render.
  private facesBaked = 0

  private stats: SessionStats = {
    totalUpdates: 0,
    totalRenderTime: 0,
    totalChunksRegenerated: 0,
    totalVoxelsRendered: 0,
    averageCacheEfficiency: 0,
    lastUpdate: null,
  }

  constructor(world: World, { bakery, onBaked }: RendererOptions = {}) {
    this.world = world
    this.camera = { ...world.spawn }
    this.bakery = bakery ?? null
    this.onBaked = onBaked ?? (() => undefined)
    this.bakery?.connect((request, image) => { this.receive(request, image) })
    this.useWorld()
  }

  render(): Frame {
    const startTime = performance.now()

    const detail = this.getDetail()
    const step = directionStep(detail)
    const boundaries = selectSlices(this.camera.z, NEAR_DEPTH, this.renderDistance, detail)
    const distances = boundaries.map(s => sliceCentre(s) - this.camera.z)
    const view = this.view()
    // Screen extent on a plane at distance d: tangents · d around the camera.
    // Null only for an empty viewport, which shows nothing.
    const tangents = viewTangents(view) ?? { minX: 0, maxX: 0, minY: 0, maxY: 0 }
    const onScreen = rectangleTest(view)
    const { x: cx, y: cy } = this.camera

    let chunksRegenerated = 0
    let chunksReused = 0
    let chunksPending = 0
    // Missing chunks, near to far. Cells that show nothing go first: while
    // the camera moves, near chunks change direction all the time and would
    // keep the workers from ever reaching them.
    const uncovered: ChunkRequest[] = []
    const stale: ChunkRequest[] = []
    const inView = new Set<Chunk>()
    const slicesInView: Slice[] = []
    const frame: Frame = {
      ...view,
      // The last slice may reach past the render distance; the sky is behind it.
      fog: this.fog(Math.max(this.renderDistance, ...distances)),
      layers: distances.map(d => ({ distance: d, placements: [], fog: this.fog(d) })),
    }

    boundaries.forEach(({ depth, size }, index) => {
      const slice = this.getSlice(depth, size)
      slicesInView.push(slice)
      const { layer } = slice
      layer.chunks = []
      if (!layer.visible) return

      // Slices start at least NEAR_DEPTH ahead of the camera, so this is > 0.
      const distance = distances[index]
      // The part of the slice's plane that is on screen (its bounding box), in world units.
      const left = this.camera.x + tangents.minX * distance
      const right = this.camera.x + tangents.maxX * distance
      const bottom = this.camera.y + tangents.minY * distance
      const top = this.camera.y + tangents.maxY * distance
      const w = slice.width
      // Voxel x covers [x - 0.5, x + 0.5], so chunk x0 covers [x0 - 0.5, x0 + w - 0.5).
      const firstX = Math.floor((left + 0.5) / w) * w
      const firstY = Math.floor((bottom + 0.5) / w) * w
      for (let x = firstX; x - 0.5 < right; x += w) {
        for (let y = firstY; y - 0.5 < top; y += w) {
          // A turned view shows a quadrilateral, less than its bounding box.
          if (!onScreen(x - 0.5 - cx, x + w - 0.5 - cx, y - 0.5 - cy, y + w - 0.5 - cy, distance)) continue
          // Bake along the grid direction nearest to the ray through the cell's centre.
          const tanX = nearestDirection((x + w / 2 - 0.5 - this.camera.x) / distance, step)
          const tanY = nearestDirection((y + w / 2 - 0.5 - this.camera.y) / distance, step)
          const key = chunkKey(x, y, tanX, tanY)
          let chunk = slice.chunks.get(key)
          if (!chunk) {
            const request = { depth, size, x, y, tanX, tanY }
            if (this.baker) {
              chunk = this.store(request, this.baker.bake(request))
            } else {
              chunksPending++
              // Until it is baked, an older bake of the cell stands in.
              chunk = slice.latest.get(cellKey(x, y))
              if (chunk) stale.push(request)
              else uncovered.push(request)
            }
            if (!chunk) continue
          }
          if (chunk.facesDrawn === 0) continue
          // The chunk's content, not just its cell, must reach the screen.
          const contentLeft = chunk.originX - cx
          const contentTop = chunk.originY - cy
          if (!onScreen(contentLeft, contentLeft + chunk.width / chunk.scale, contentTop - chunk.height / chunk.scale, contentTop, distance)) continue
          if (this.fresh.has(chunk)) {
            this.fresh.delete(chunk)
            chunksRegenerated++
          } else {
            chunksReused++
          }
          layer.chunks.push(chunk)
          inView.add(chunk)
          frame.layers[index].placements.push({ chunk, x: contentLeft, y: contentTop })
        }
      }
    })

    this.inView = inView
    this.visibleSlices = slicesInView
    this.evict()
    this.bakery?.want([...uncovered, ...stale])
    const voxelsRendered = this.facesBaked
    this.facesBaked = 0

    const chunkCount = chunksReused + chunksRegenerated
    const renderTime = performance.now() - startTime
    const cacheEfficiency = chunkCount > 0 ? (chunksReused / chunkCount) * 100 : 100
    const s = this.stats
    s.totalUpdates++
    s.totalRenderTime += renderTime
    s.totalChunksRegenerated += chunksRegenerated
    s.totalVoxelsRendered += voxelsRendered
    s.averageCacheEfficiency += (cacheEfficiency - s.averageCacheEfficiency) / s.totalUpdates
    s.lastUpdate = {
      renderTime,
      detail,
      layerCount: boundaries.length,
      chunkCount,
      chunksReused,
      chunksRegenerated,
      chunksPending,
      voxelsRendered,
      cacheEfficiency,
      cachedPixels: this.cachedPixels(() => true),
    }
    return frame
  }

  getCamera(): Camera {
    return { ...this.camera }
  }

  setCamera(camera: Partial<Camera>) {
    this.camera = { ...this.camera, ...camera }
  }

  getOrientation(): Orientation {
    return { ...this.orientation }
  }

  /** Turns the view towards `orientation`, as far as the slices reach (see turn()). */
  setOrientation(orientation: Partial<Orientation>) {
    this.orientation = turn(this.view(), { ...this.orientation, ...orientation })
  }

  getWorld(): World {
    return this.world
  }

  getStats(): SessionStats {
    return { ...this.stats }
  }

  /** Sets the viewport size in CSS pixels. Cached chunks stay valid; call render() to reposition them. */
  resize(width: number, height: number) {
    this.width = width
    this.height = height
    this.setOrientation({})
  }

  /** Replaces the world and moves the camera to its spawn point. */
  regenerateWorld(seed?: number, worldType?: WorldType) {
    this.world = new World(seed, worldType)
    this.camera = { ...this.world.spawn }
    this.inView.clear()
    this.visibleSlices = []
    this.slices.clear()
    this.facesBaked = 0
    this.useWorld()
  }

  private useWorld() {
    if (this.bakery) this.bakery.setWorld(this.world.grid)
    else this.baker = new ChunkBaker(this.world.grid)
  }

  getFov(): number {
    return this.fov
  }

  /**
   * Sets the field of view in degrees (clamped to [MIN_FOV, MAX_FOV]). It
   * zooms, and changes the focal length the slicing depends on (see
   * bakeAngleError).
   */
  setFov(fov: number) {
    this.fov = Math.min(MAX_FOV, Math.max(MIN_FOV, fov))
    this.setOrientation({})
  }

  getRenderDistance(): number {
    return this.renderDistance
  }

  /** Sets how far ahead slices are drawn (clamped to [MIN_RENDER_DISTANCE, MAX_RENDER_DISTANCE]). */
  setRenderDistance(distance: number) {
    this.renderDistance = Math.min(MAX_RENDER_DISTANCE, Math.max(MIN_RENDER_DISTANCE, distance))
  }

  getMaxLeak(): number {
    return this.maxLeak
  }

  /**
   * Sets how many screen pixels of hidden geometry may show between slices
   * (clamped to [MIN_MAX_LEAK, MAX_MAX_LEAK]). Slices are keyed by depth and
   * size, so the ones still needed stay cached.
   */
  setMaxLeak(pixels: number) {
    this.maxLeak = Math.min(MAX_MAX_LEAK, Math.max(MIN_MAX_LEAK, pixels))
  }

  /**
   * Slice detail that keeps occlusion leaks within the tolerance on the
   * current viewport. It does not depend on the orientation, so turning
   * keeps the slices.
   */
  getDetail(): number {
    return leakFreeDetail(focalLength(this.fov, this.width, this.height), MAX_VIEW_TANGENT, this.maxLeak)
  }

  private view(): View {
    return {
      orientation: this.orientation,
      width: this.width,
      height: this.height,
      focal: focalLength(this.fov, this.width, this.height),
    }
  }

  /** Layers of the most recent render, sorted near to far. */
  getLayers(): Layer[] {
    return this.visibleSlices.map(s => s.layer)
  }

  /** Toggles the visible layer starting at `depth` (visible slices never share a depth). */
  toggleLayerVisibility(depth: number) {
    const layer = this.getLayers().find(l => l.depth === depth)
    if (layer) layer.visible = !layer.visible
  }

  /** Share of the fog colour at viewing distance d. */
  private fog(d: number): number {
    return 1 - Math.exp(-d / (this.renderDistance * FOG_PER_RENDER_DISTANCE))
  }

  /** Returns the cached slice, or a new one with no chunks. */
  private getSlice(depth: number, size: number): Slice {
    const key = sliceKey(depth, size)
    const cached = this.slices.get(key)
    if (cached) {
      // Re-insert to mark as most recently used.
      this.slices.delete(key)
      this.slices.set(key, cached)
      return cached
    }

    const slice: Slice = {
      layer: { depth, size, voxelCount: this.world.grid.countInZ(depth, depth + size), chunks: [], visible: true },
      width: chunkWidth(size),
      chunks: new Map(),
      latest: new Map(),
    }
    this.slices.set(key, slice)
    return slice
  }

  /** Caches a baked chunk, unless its slice has been evicted meanwhile. */
  private store(request: ChunkRequest, image: ChunkImage): Chunk | undefined {
    const { depth, size, x, y, tanX, tanY } = request
    const slice = this.slices.get(sliceKey(depth, size))
    const key = chunkKey(x, y, tanX, tanY)
    if (!slice || slice.chunks.has(key)) return
    const chunk: Chunk = { ...image, x, y, tanX, tanY }
    slice.chunks.set(key, chunk)
    slice.latest.set(cellKey(x, y), chunk)
    this.fresh.add(chunk)
    this.facesBaked += chunk.facesDrawn
    return chunk
  }

  private receive(request: ChunkRequest, image: ChunkImage) {
    this.store(request, image)
    this.onBaked()
  }

  private cachedPixels(include: (chunk: Chunk) => boolean): number {
    let pixels = 0
    for (const slice of this.slices.values()) {
      for (const chunk of slice.chunks.values()) {
        if (include(chunk)) pixels += chunk.width * chunk.height
      }
    }
    return pixels
  }

  /**
   * Drops least-recently-used slices beyond MAX_CACHED_SLICES, then hidden
   * chunks (least recently used slices first) until they fit
   * MAX_HIDDEN_CHUNK_PIXELS. What is in view is never evicted.
   */
  private evict() {
    const inView = new Set(this.visibleSlices)
    for (const [key, slice] of this.slices) {
      if (this.slices.size <= MAX_CACHED_SLICES) break
      if (!inView.has(slice)) this.slices.delete(key)
    }
    let hidden = this.cachedPixels(chunk => !this.inView.has(chunk))
    for (const slice of this.slices.values()) {
      if (hidden <= MAX_HIDDEN_CHUNK_PIXELS) return
      for (const [key, chunk] of slice.chunks) {
        if (this.inView.has(chunk)) continue
        hidden -= chunk.width * chunk.height
        slice.chunks.delete(key)
        const cell = cellKey(chunk.x, chunk.y)
        if (slice.latest.get(cell) === chunk) slice.latest.delete(cell)
      }
    }
  }
}
