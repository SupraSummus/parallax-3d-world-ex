import { selectSlices, leakFreeDetail, directionStep, nearestDirection, sliceCentre, chunkCell } from './slice-selection'
import { ChunkBaker, type ChunkImage, type ChunkRequest } from './chunk-baker'
import { World, type Vec3, type WorldType } from './world'
import type { VoxelData } from './voxel-grid'
import { Coverage } from './occlusion'
import { FACES, LAYER, faceTangents, inFace, focalLength, onScreen, screenBox, toLocal, type Face, type Orientation, type ScreenBox, type View } from './view'

export type Camera = Vec3

/** A rasterised, aligned piece of a slice (see chunkCell). */
export interface Chunk extends ChunkImage {
  /** Its cell (see chunkCell). */
  i: number
  j: number
  /**
   * Baking direction (tangents): the chunk is the parallel projection of
   * its slice along (tanX, tanY, 1) onto the slice's centre plane.
   */
  tanX: number
  tanY: number
  /** Slice detail the faces are grown for, to fill gaps; 0 if not. See chunkFaces. */
  fillDetail: number
}

/**
 * A chunk in a frame: x, y of its top-left corner on its layer's plane,
 * relative to the camera, in the face's coordinates. It spans chunk.width /
 * chunk.scale to the right and chunk.height / chunk.scale down.
 */
export interface Placement {
  chunk: Chunk
  x: number
  y: number
}

/**
 * What to draw, seen through `View` (see projector() in view.ts). Layers
 * go face by face, near to far; a face draws only its own rays (inFace in
 * view.ts), and nearer layers hide what is behind them. A layer is the
 * plane `distance` ahead of the camera along its face's axis (its slice's
 * centre). `fog` is the share of the horizon colour mixed into a layer's
 * pixels, and into the sky where no layer is drawn.
 */
export interface Frame extends View {
  fog: number
  layers: { face: Face; distance: number; placements: Placement[]; fog: number }[]
}

export interface Layer {
  /** Name of the face whose axis the slice is cut along, e.g. '+x+z'. */
  face: string
  /** First layer of the slice, in its face's lattice coordinates (see Face in view.ts). */
  depth: number
  /** Number of layers; the slice holds voxels of layers [depth, depth + size). */
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
  /** Cells and chunks in view covered by nearer layers, so not drawn (see Coverage). */
  chunksCovered: number
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
// distance, in world units (a voxel's neighbours are √2 away, see fcc.ts).
const NEAR_DEPTH = 2
export const DEFAULT_RENDER_DISTANCE = 400
export const MIN_RENDER_DISTANCE = 40
export const MAX_RENDER_DISTANCE = 800

// Slices and chunks outside the view are kept so that moving or turning
// back reuses them, up to these caps (a face has about 150 slices, and 12 faces
// look all around). What is in view is never evicted.
const MAX_CACHED_SLICES = 2048
const MAX_HIDDEN_CHUNK_PIXELS = 32_000_000

// Exponential distance fog towards the horizon colour: at viewing distance d
// a voxel keeps exp(-d / fogDistance) of its own colour. The fog distance
// scales with the render distance so the far cut-off stays hazy.
export const FOG_PER_RENDER_DISTANCE = 0.7

function sliceKey(face: string, depth: number, size: number): string {
  return `${face}:${String(depth)}:${String(size)}`
}

/** A cached slice and the chunks baked so far. */
interface Slice {
  layer: Layer
  /** Chunk cells, see chunkCell. */
  cell: ReturnType<typeof chunkCell>
  /** Keyed by chunkKey. */
  chunks: Map<string, Chunk>
  /** The most recently baked chunk of each cell (keyed by cellKey), shown while the one wanted is baking. */
  latest: Map<string, Chunk>
}

/** |v| for the v in [lo, hi] nearest to 0. */
const closestToZero = (lo: number, hi: number) => (lo > 0 ? lo : hi < 0 ? -hi : 0)

function cellKey(i: number, j: number): string {
  return `${String(i)},${String(j)}`
}

function chunkKey({ i, j, tanX, tanY, fillDetail }: ChunkRequest): string {
  return `${cellKey(i, j)},${String(tanX)},${String(tanY)},${String(fillDetail)}`
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
 * chunk goes on screen; drawing it is the compositor's job. See
 * docs/architecture.md for the slicing and caching scheme.
 */
export class ParallaxRenderer {
  private world: World
  private camera: Camera
  private orientation: Orientation = { yaw: 0, pitch: 0 }
  private fov = DEFAULT_FOV
  private maxLeak = DEFAULT_MAX_LEAK
  private renderDistance = DEFAULT_RENDER_DISTANCE
  private fillGaps = true
  private skipCovered = true
  private width = 0
  private height = 0

  // Keyed by sliceKey(face, depth, size). Map insertion order doubles as
  // LRU order (oldest first).
  private slices = new Map<string, Slice>()
  // Slices of the most recent render, face by face, near to far.
  private visibleSlices: Slice[] = []
  // Chunks of the cells in view in the most recent render, drawn or not:
  // evicted, one would be baked again on the next render.
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
    const fillDetail = this.fillGaps ? detail : 0
    const view = this.view()

    let chunksRegenerated = 0
    let chunksReused = 0
    let chunksPending = 0
    let farthest = this.renderDistance
    // Missing chunks, near to far across faces. Cells that show nothing go
    // first: while the camera moves, near chunks change direction all the
    // time and would keep the workers from ever reaching them.
    const uncovered: { request: ChunkRequest; distance: number }[] = []
    const stale: { request: ChunkRequest; distance: number }[] = []
    // Never baked and covered by nearer layers: baked last, so it is there
    // when a nearer slice re-tiles and has nothing to show for a while.
    const behind: { request: ChunkRequest; distance: number }[] = []
    const inView = new Set<Chunk>()
    const slicesInView: Slice[] = []
    let chunksCovered = 0
    const frame: Frame = { ...view, fog: 0, layers: [] }
    const coverage = this.skipCovered ? new Coverage(view) : null

    for (const face of FACES) {
      // The face's part of the screen, on a plane at distance d: tangents · d around the camera.
      const tangents = faceTangents(view, face)
      if (!tangents) continue
      const boxOf = screenBox(view, face)
      const covered = (box: ScreenBox) => {
        const c = coverage?.hides(box) ?? false
        if (c) chunksCovered++
        return c
      }
      const camera = toLocal(face, this.camera)
      coverage?.setFace(face)

      for (const { depth, size } of selectSlices(camera.z / LAYER, NEAR_DEPTH / LAYER, this.renderDistance / LAYER, detail)) {
        const slice = this.getSlice(face, depth, size)
        slicesInView.push(slice)
        // Slices start at least NEAR_DEPTH ahead of the camera, so this is > 0.
        const distance = sliceCentre({ depth, size }) - camera.z
        farthest = Math.max(farthest, distance)
        const placements: Placement[] = []
        frame.layers.push({ face, distance, placements, fog: this.fog(distance) })
        const { layer } = slice
        layer.chunks = []
        if (!layer.visible) continue

        // The bounding box of the face's part of the slice's plane.
        const left = camera.x + tangents.minX * distance
        const right = camera.x + tangents.maxX * distance
        const bottom = camera.y + tangents.minY * distance
        const top = camera.y + tangents.maxY * distance
        const { width: w, height: h } = slice.cell
        // Cell (i, j) draws [i · w, (i + 1) · w) × [j · h, (j + 1) · h).
        for (let i = Math.floor(left / w); i * w < right; i++) {
          for (let j = Math.floor(bottom / h); j * h < top; j++) {
            // The face draws only its own rays: the cell must reach its rhombus (inFace).
            const [x0, x1, y0, y1] = [i * w - camera.x, (i + 1) * w - camera.x, j * h - camera.y, (j + 1) * h - camera.y]
            if (!inFace(closestToZero(x0, x1), closestToZero(y0, y1), distance)) continue
            // The screen shows a quadrilateral of the plane, less than its bounding box.
            const cellBox = boxOf(x0, x1, y0, y1, distance)
            if (!onScreen(view, cellBox)) continue
            // Bake along the grid direction nearest to the ray through the cell's centre,
            // within the face's rays: the rays shown are, and baking needs it (see chunkFaces).
            const tanX = Math.max(-1, Math.min(1, nearestDirection(((i + 0.5) * w - camera.x) / distance, step)))
            const maxY = (1 - Math.abs(tanX)) * LAYER
            const tanY = Math.max(-maxY, Math.min(maxY, nearestDirection(((j + 0.5) * h - camera.y) / distance, step)))
            const request = { face: face.name, depth, size, i, j, tanX, tanY, fillDetail }
            let chunk = slice.chunks.get(chunkKey(request))
            if (covered(cellBox)) {
              // Not drawn, but kept; a cell never baked is baked last.
              const kept = chunk ?? slice.latest.get(cellKey(i, j))
              if (kept) inView.add(kept)
              else if (!this.baker) behind.push({ request, distance })
              continue
            }
            if (!chunk) {
              if (this.baker) {
                chunk = this.store(request, this.baker.bake(request))
              } else {
                chunksPending++
                // Until it is baked, an older bake of the cell stands in.
                chunk = slice.latest.get(cellKey(i, j))
                ;(chunk ? stale : uncovered).push({ request, distance })
              }
              if (!chunk) continue
            }
            inView.add(chunk)
            if (chunk.facesDrawn === 0) continue
            // The chunk's content, not just its cell, must reach the screen.
            const contentLeft = chunk.originX - camera.x
            const contentTop = chunk.originY - camera.y
            const box = boxOf(contentLeft, contentLeft + chunk.width / chunk.scale, contentTop - chunk.height / chunk.scale, contentTop, distance)
            if (!onScreen(view, box) || covered(box)) continue
            if (this.fresh.has(chunk)) {
              this.fresh.delete(chunk)
              chunksRegenerated++
            } else {
              chunksReused++
            }
            layer.chunks.push(chunk)
            placements.push({ chunk, x: contentLeft, y: contentTop })
          }
        }
        coverage?.cover(placements, distance, slice.cell, camera)
      }
    }
    // The last slice may reach past the render distance; the sky is behind it.
    frame.fog = this.fog(farthest)

    this.inView = inView
    this.visibleSlices = slicesInView
    this.evict()
    const nearFirst = (missing: { request: ChunkRequest; distance: number }[]) =>
      missing.sort((a, b) => a.distance - b.distance).map(m => m.request)
    this.bakery?.want([...nearFirst(uncovered), ...nearFirst(stale), ...nearFirst(behind)])
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
      layerCount: frame.layers.length,
      chunkCount,
      chunksReused,
      chunksRegenerated,
      chunksPending,
      chunksCovered,
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

  /** Turns the view; pitch stops at straight up or down, yaw wraps to [-180, 180). */
  setOrientation(orientation: Partial<Orientation>) {
    const { yaw, pitch } = { ...this.orientation, ...orientation }
    this.orientation = { yaw: yaw - 360 * Math.floor((yaw + 180) / 360), pitch: Math.min(90, Math.max(-90, pitch)) }
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

  /** Whether faces are grown to fill the gaps between slices (see chunkFaces). */
  setFillGaps(fill: boolean) {
    this.fillGaps = fill
  }

  /** Whether chunks covered by nearer layers are skipped: not drawn, and baked last (see Coverage). */
  setSkipCovered(skip: boolean) {
    this.skipCovered = skip
  }

  /**
   * Slice detail that keeps occlusion leaks within the tolerance on the
   * current viewport. A face draws rays within tangent 1 of its axis,
   * however the camera is turned, so turning keeps the slices.
   */
  getDetail(): number {
    return leakFreeDetail(focalLength(this.fov, this.width, this.height), 1, this.maxLeak)
  }

  private view(): View {
    return {
      orientation: this.orientation,
      width: this.width,
      height: this.height,
      focal: focalLength(this.fov, this.width, this.height),
    }
  }

  /** Layers of the most recent render, face by face, near to far. */
  getLayers(): Layer[] {
    return this.visibleSlices.map(s => s.layer)
  }

  /** Toggles the visible layer of `face` starting at `depth` (a face's visible slices never share a depth). */
  toggleLayerVisibility(face: string, depth: number) {
    const layer = this.getLayers().find(l => l.face === face && l.depth === depth)
    if (layer) layer.visible = !layer.visible
  }

  /** Share of the fog colour at viewing distance d. */
  private fog(d: number): number {
    return 1 - Math.exp(-d / (this.renderDistance * FOG_PER_RENDER_DISTANCE))
  }

  /** Returns the cached slice, or a new one with no chunks. */
  private getSlice(face: Face, depth: number, size: number): Slice {
    const key = sliceKey(face.name, depth, size)
    const cached = this.slices.get(key)
    if (cached) {
      // Re-insert to mark as most recently used.
      this.slices.delete(key)
      this.slices.set(key, cached)
      return cached
    }

    const slice: Slice = {
      layer: { face: face.name, depth, size, voxelCount: this.world.grid.countAlong(face.lattice.forward, depth, depth + size), chunks: [], visible: true },
      cell: chunkCell(size),
      chunks: new Map(),
      latest: new Map(),
    }
    this.slices.set(key, slice)
    return slice
  }

  /** Caches a baked chunk, unless its slice has been evicted meanwhile. */
  private store(request: ChunkRequest, image: ChunkImage): Chunk | undefined {
    const { face, depth, size, i, j, tanX, tanY, fillDetail } = request
    const slice = this.slices.get(sliceKey(face, depth, size))
    const key = chunkKey(request)
    if (!slice || slice.chunks.has(key)) return
    const chunk: Chunk = { ...image, i, j, tanX, tanY, fillDetail }
    slice.chunks.set(key, chunk)
    slice.latest.set(cellKey(i, j), chunk)
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
        const cell = cellKey(chunk.i, chunk.j)
        if (slice.latest.get(cell) === chunk) slice.latest.delete(cell)
      }
    }
  }
}
