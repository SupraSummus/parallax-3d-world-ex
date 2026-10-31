import { selectSlices, leakFreeDetail, chunkWidth, directionStep, nearestDirection, sliceCentre } from './slice-selection'
import { openFaces, bakedFaces, fillConvex, type SurfaceVoxel } from './bake'
import { World, type Vec3, type Voxel, type WorldType } from './world'

export type Camera = Vec3

/** A rasterised, aligned square piece of a slice (see chunkWidth). */
export interface Chunk {
  /** Aligned corner: the chunk shows voxels with x in [x, x + width), y likewise. */
  x: number
  y: number
  /**
   * Baking direction (tangents): the chunk is the parallel projection of
   * its slice along (tanX, tanY, 1) onto the slice's centre plane.
   */
  tanX: number
  tanY: number
  /** Cropped to the chunk's content; see originX/originY. */
  canvas: HTMLCanvasElement
  /** World x, y of the canvas's top-left corner. */
  originX: number
  originY: number
  /** Canvas pixels per world unit (see renderScale). */
  scale: number
  /** Number of voxel faces drawn on the canvas. */
  facesDrawn: number
}

export interface Layer {
  /** First integer z of the slice. */
  depth: number
  /** Thickness in z units; the slice holds voxels with z in [depth, depth + size). */
  size: number
  /** All voxels in the slice (most are hidden behind nearer ones). */
  voxels: Voxel[]
  /** Non-empty chunks in view in the most recent render. */
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
  chunksRegenerated: number
  /** Voxel faces drawn into newly rasterised chunks (including any whose content turned out to be off screen). */
  voxelsRendered: number
  /** Percentage of chunks in view served from the cache. */
  cacheEfficiency: number
  /** Pixels of all cached chunk canvases, in view or not. */
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

// Field of view across the longer viewport side, in degrees. Pixels per
// world unit at viewing distance d are focalLength / d, where the focal
// length (in pixels) puts the longer side's edges at ±fov / 2.
export const DEFAULT_FOV = 90
export const MIN_FOV = 5
export const MAX_FOV = 120

/** Focal length in pixels: the longer viewport side spans `fov` degrees. */
export function focalLength(fov: number, width: number, height: number): number {
  return Math.max(width, height) / 2 / Math.tan((fov * Math.PI) / 360)
}

// Pixels per world unit used when rasterising the nearest (size-1) slices.
// Canvases are rendered camera-independently so they can be cached and
// reused as the camera moves; perspective scaling is applied via a CSS
// transform at composite time.
const RENDER_SCALE = 10

/**
 * Canvas pixels per world unit for a slice of `size`: 24 / size, between 2
 * and RENDER_SCALE. A slice of size s ≥ 2 lies at distance ≥ s · detail,
 * where a voxel is at most focal / (s · detail) screen pixels, about 24 / s
 * with the defaults; finer canvases would not show. Other settings just
 * scale the canvas on screen.
 */
function renderScale(size: number): number {
  return Math.max(2, Math.min(RENDER_SCALE, Math.floor(24 / size)))
}

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

// Slices and chunks outside the view are kept (without DOM elements) so that
// moving back reuses them, up to these caps. What is in view is never evicted.
const MAX_CACHED_SLICES = 64
const MAX_HIDDEN_CHUNK_PIXELS = 32_000_000

// Sky gradient; the horizon sits at eye level (screen centre).
export const SKY_TOP = '#3f73b8'
export const SKY_HORIZON = '#b9d3e8'
// Exponential distance fog towards the horizon colour: at viewing distance d
// a voxel keeps exp(-d / fogDistance) of its own colour. The fog distance
// scales with the render distance so the far cut-off stays hazy.
const FOG_RGB = '185, 211, 232'
export const FOG_PER_RENDER_DISTANCE = 0.7
// Minimum opacity of one fog overlay. Each overlay is blended in 8 bits, so
// hundreds of nearly transparent overlays (one per thin slice) round every
// channel differently and tint the scene; fewer, stronger steps don't.
const MIN_FOG_STEP = 0.05

function sliceKey(depth: number, size: number): string {
  return `${String(depth)}:${String(size)}`
}

/** Packs integer x, y (|x|, |y| < 2^20) into one number. */
function cellKey(x: number, y: number): number {
  return (x + 1048576) * 2097152 + (y + 1048576)
}

/** A cached slice: its voxels grouped by chunk cell, and the chunks rasterised so far. */
interface Slice {
  layer: Layer
  /** Chunk width, see chunkWidth. */
  width: number
  /** Voxels with a face a baking ray can reach, by chunk cell (keyed by cellKey of the cell corner). */
  cells: Map<number, SurfaceVoxel[]>
  /** Keyed by chunkKey. */
  chunks: Map<string, Chunk>
  fog: HTMLDivElement | null
}

function chunkKey(x: number, y: number, tanX: number, tanY: number): string {
  return `${String(x)},${String(y)},${String(tanX)},${String(tanY)}`
}

/**
 * Renders a World as a stack of flat, cached slices composited by the
 * browser, each split into chunks so that only what is in view is
 * rasterised. See DESIGN.md for the slicing and caching scheme.
 */
export class ParallaxRenderer {
  private container: HTMLElement
  private world: World
  private camera: Camera
  private fov = DEFAULT_FOV
  private maxLeak = DEFAULT_MAX_LEAK
  private renderDistance = DEFAULT_RENDER_DISTANCE
  private width: number
  private height: number

  // Keyed by sliceKey(depth, size). Map insertion order doubles as LRU order
  // (oldest first).
  private slices = new Map<string, Slice>()
  // Slices of the most recent render, near to far.
  private visibleSlices: Slice[] = []
  // Chunk canvases attached to the container, i.e. in view.
  private attached = new Set<HTMLCanvasElement>()

  private stats: SessionStats = {
    totalUpdates: 0,
    totalRenderTime: 0,
    totalChunksRegenerated: 0,
    totalVoxelsRendered: 0,
    averageCacheEfficiency: 0,
    lastUpdate: null,
  }

  constructor(container: HTMLElement, world: World) {
    this.container = container
    this.container.style.background = `linear-gradient(${SKY_TOP}, ${SKY_HORIZON} 50%)`
    this.width = container.clientWidth
    this.height = container.clientHeight
    this.world = world
    this.camera = { ...world.spawn }
  }

  render() {
    const startTime = performance.now()

    // Far to near, so nearer slices stack on top.
    const detail = this.getDetail()
    const step = directionStep(detail)
    const boundaries = selectSlices(this.camera.z, NEAR_DEPTH, this.renderDistance, detail).reverse()
    const distances = boundaries.map(s => sliceCentre(s) - this.camera.z)
    const fogAlphas = this.fogAlphas(distances)
    const focal = focalLength(this.fov, this.width, this.height)

    let chunksRegenerated = 0
    let chunksReused = 0
    let voxelsRendered = 0
    const inView = new Set<HTMLCanvasElement>()
    const slicesInView: Slice[] = []

    boundaries.forEach(({ depth, size }, index) => {
      const slice = this.getSlice(depth, size)
      slicesInView.push(slice)
      const { layer } = slice
      layer.chunks = []

      const fog = slice.fog ?? this.createFog()
      slice.fog = fog
      fog.style.zIndex = String(index * 2 + 1)
      // Fog stays even for hidden layers so the slices behind keep their haze.
      fog.style.backgroundColor = `rgba(${FOG_RGB}, ${fogAlphas[index].toFixed(4)})`
      fog.style.display = fogAlphas[index] > 0 ? '' : 'none'
      if (!layer.visible) return

      // Slices start at least NEAR_DEPTH ahead of the camera, so this is > 0.
      const distance = distances[index]
      const scale = focal / distance
      // The part of the slice's plane that is on screen, in world units.
      const left = this.camera.x - this.width / 2 / scale
      const right = this.camera.x + this.width / 2 / scale
      const bottom = this.camera.y - this.height / 2 / scale
      const top = this.camera.y + this.height / 2 / scale
      const w = slice.width
      // Voxel x covers [x - 0.5, x + 0.5], so chunk x0 covers [x0 - 0.5, x0 + w - 0.5).
      const firstX = Math.floor((left + 0.5) / w) * w
      const firstY = Math.floor((bottom + 0.5) / w) * w
      for (let x = firstX; x - 0.5 < right; x += w) {
        for (let y = firstY; y - 0.5 < top; y += w) {
          // Bake along the grid direction nearest to the ray through the cell's centre.
          const tanX = nearestDirection((x + w / 2 - 0.5 - this.camera.x) / distance, step)
          const tanY = nearestDirection((y + w / 2 - 0.5 - this.camera.y) / distance, step)
          const key = chunkKey(x, y, tanX, tanY)
          let chunk = slice.chunks.get(key)
          const cached = chunk !== undefined
          if (!chunk) {
            const voxels = this.voxelsNear(slice, x, y, tanX, tanY)
            if (voxels.length === 0) continue
            chunk = this.rasterise(slice, x, y, tanX, tanY, voxels)
            slice.chunks.set(key, chunk)
            voxelsRendered += chunk.facesDrawn
          }
          if (chunk.facesDrawn === 0) continue
          // The chunk's content, not just its cell, must reach the screen.
          if (chunk.originX >= right || chunk.originX + chunk.canvas.width / chunk.scale <= left) continue
          if (chunk.originY <= bottom || chunk.originY - chunk.canvas.height / chunk.scale >= top) continue
          if (cached) chunksReused++
          else chunksRegenerated++
          layer.chunks.push(chunk)
          inView.add(chunk.canvas)
          this.composite(chunk, index, scale)
        }
      }
    })

    for (const canvas of this.attached) {
      if (!inView.has(canvas)) canvas.remove()
    }
    this.attached = inView
    const stillVisible = new Set(slicesInView)
    for (const slice of this.visibleSlices) {
      if (!stillVisible.has(slice)) this.removeFog(slice)
    }
    this.visibleSlices = slicesInView.reverse()
    this.evict()

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
      voxelsRendered,
      cacheEfficiency,
      cachedPixels: this.cachedPixels(() => true),
    }
  }

  getCamera(): Camera {
    return { ...this.camera }
  }

  setCamera(camera: Partial<Camera>) {
    this.camera = { ...this.camera, ...camera }
  }

  getWorld(): World {
    return this.world
  }

  getStats(): SessionStats {
    return { ...this.stats }
  }

  /** Sets the viewport size. Cached chunks stay valid; call render() to reposition them. */
  resize(width: number, height: number) {
    this.width = width
    this.height = height
  }

  /** Replaces the world and moves the camera to its spawn point. */
  regenerateWorld(seed?: number, worldType?: WorldType) {
    this.world = new World(seed, worldType)
    this.camera = { ...this.world.spawn }
    for (const canvas of this.attached) canvas.remove()
    this.attached.clear()
    for (const slice of this.visibleSlices) this.removeFog(slice)
    this.visibleSlices = []
    this.slices.clear()
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

  /** Slice detail that keeps occlusion leaks within the tolerance on the current viewport. */
  getDetail(): number {
    const tanHalfFov = Math.tan((this.fov * Math.PI) / 360)
    return leakFreeDetail(focalLength(this.fov, this.width, this.height), tanHalfFov, this.maxLeak)
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

  /**
   * Overlay k tints slice k and everything behind it. Walking near to far,
   * an overlay gets the fog of the depth interval since the previous overlay
   * once that reaches MIN_FOG_STEP, so the accumulated fog at slice d is
   * 1 - exp(-d / fogDistance), rounded down to the last step.
   */
  private fogAlphas(distances: number[]): number[] {
    const fogDistance = this.renderDistance * FOG_PER_RENDER_DISTANCE
    const alphas = distances.map(() => 0)
    let foggedDistance = 0
    for (let i = distances.length - 1; i >= 0; i--) {
      const alpha = 1 - Math.exp(-(distances[i] - foggedDistance) / fogDistance)
      if (alpha >= MIN_FOG_STEP) {
        alphas[i] = alpha
        foggedDistance = distances[i]
      }
    }
    return alphas
  }

  /** Returns the cached slice, or indexes a new one by chunk cell. Nothing is rasterised yet. */
  private getSlice(depth: number, size: number): Slice {
    const key = sliceKey(depth, size)
    const cached = this.slices.get(key)
    if (cached) {
      // Re-insert to mark as most recently used.
      this.slices.delete(key)
      this.slices.set(key, cached)
      return cached
    }

    const voxels = this.world.getVoxelsInZRange(depth, depth + size)
    const width = chunkWidth(size)
    const cells = new Map<number, SurfaceVoxel[]>()
    const has = (x: number, y: number, z: number) => this.world.has(x, y, z)
    for (const voxel of voxels) {
      const open = openFaces(voxel, depth, has)
      // Buried voxels have no face to draw.
      if (open === 0) continue
      const k = cellKey(Math.floor(voxel.x / width) * width, Math.floor(voxel.y / width) * width)
      const list = cells.get(k)
      if (list) list.push({ voxel, open })
      else cells.set(k, [{ voxel, open }])
    }
    const slice: Slice = {
      layer: { depth, size, voxels, chunks: [], visible: true },
      width,
      cells,
      chunks: new Map(),
      fog: null,
    }
    this.slices.set(key, slice)
    return slice
  }

  /**
   * Voxels whose projection along (tanX, tanY, 1) can reach the cell at
   * (x, y): within |tan|·s/2 + 1 of it. That is less than a cell width, so
   * only the cell and its eight neighbours need looking at.
   */
  private voxelsNear(slice: Slice, x: number, y: number, tanX: number, tanY: number): SurfaceVoxel[] {
    const w = slice.width
    const marginX = (Math.abs(tanX) * slice.layer.size) / 2 + 1
    const marginY = (Math.abs(tanY) * slice.layer.size) / 2 + 1
    const result: SurfaceVoxel[] = []
    for (let dx = -w; dx <= w; dx += w) {
      for (let dy = -w; dy <= w; dy += w) {
        const cell = slice.cells.get(cellKey(x + dx, y + dy))
        if (!cell) continue
        if (dx === 0 && dy === 0) {
          result.push(...cell)
          continue
        }
        for (const v of cell) {
          const { x: vx, y: vy } = v.voxel
          if (vx > x - 1 - marginX && vx < x + w + marginX && vy > y - 1 - marginY && vy < y + w + marginY) {
            result.push(v)
          }
        }
      }
    }
    return result
  }

  /**
   * Rasterises one chunk: the slice baked along (tanX, tanY, 1) onto its
   * centre plane (see bake.ts), clipped to the chunk's cell and cropped to
   * what is drawn there.
   */
  private rasterise(slice: Slice, x0: number, y0: number, tanX: number, tanY: number, voxels: SurfaceVoxel[]): Chunk {
    const faces = bakedFaces(voxels, tanX, tanY, sliceCentre(slice.layer))

    // Drawn extent, clipped to the cell [x0 - 0.5, x0 + w - 0.5) × [y0 - 0.5, y0 + w - 0.5).
    const w = slice.width
    let minX = x0 + w - 0.5
    let maxX = x0 - 0.5
    let minY = y0 + w - 0.5
    let maxY = y0 - 0.5
    for (const { corners } of faces) {
      for (const [px, py] of corners) {
        minX = Math.min(minX, px)
        maxX = Math.max(maxX, px)
        minY = Math.min(minY, py)
        maxY = Math.max(maxY, py)
      }
    }
    minX = Math.max(minX, x0 - 0.5)
    maxX = Math.min(maxX, x0 + w - 0.5)
    minY = Math.max(minY, y0 - 0.5)
    maxY = Math.min(maxY, y0 + w - 0.5)

    const scale = renderScale(slice.layer.size)
    const canvas = document.createElement('canvas')
    const empty = maxX <= minX || maxY <= minY
    canvas.width = empty ? 0 : Math.ceil((maxX - minX) * scale)
    canvas.height = empty ? 0 : Math.ceil((maxY - minY) * scale)
    Object.assign(canvas.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      transformOrigin: '0 0',
      willChange: 'transform',
      pointerEvents: 'none',
    })
    const chunk: Chunk = { x: x0, y: y0, tanX, tanY, canvas, originX: minX, originY: maxY, scale, facesDrawn: 0 }
    const ctx = empty ? null : canvas.getContext('2d')
    if (!ctx) return chunk

    // Without antialiasing: magnified many times on screen, a soft 1-pixel
    // edge would become a wide blur.
    const image = ctx.createImageData(canvas.width, canvas.height)
    const pixels = new Uint32Array(image.data.buffer)
    for (const { voxel, shade, corners } of faces) {
      const points = corners.map(([px, py]): [number, number] => [(px - minX) * scale, (maxY - py) * scale])
      if (fillConvex(pixels, canvas.width, canvas.height, points, pixelColor(voxel.color, shade))) chunk.facesDrawn++
    }
    ctx.putImageData(image, 0, 0)
    return chunk
  }

  private createFog(): HTMLDivElement {
    const fog = document.createElement('div')
    Object.assign(fog.style, { position: 'absolute', inset: '0', pointerEvents: 'none' })
    this.container.append(fog)
    return fog
  }

  private removeFog(slice: Slice) {
    slice.fog?.remove()
    slice.fog = null
  }

  /**
   * Positions a cached chunk canvas for the current camera: scale for
   * perspective and translate for parallax. Only CSS changes here, never
   * pixels.
   */
  private composite(chunk: Chunk, stackIndex: number, scale: number) {
    const { canvas } = chunk
    if (canvas.parentNode !== this.container) this.container.append(canvas)
    canvas.style.zIndex = String(stackIndex * 2)
    const left = this.width / 2 + (chunk.originX - this.camera.x) * scale
    const top = this.height / 2 - (chunk.originY - this.camera.y) * scale
    canvas.style.transform =
      `translate3d(${String(left)}px, ${String(top)}px, 0) scale(${String(scale / chunk.scale)})`
    // Keep voxel edges crisp when magnified; smooth when minified.
    canvas.style.imageRendering = scale > chunk.scale ? 'pixelated' : 'auto'
  }

  private cachedPixels(include: (canvas: HTMLCanvasElement) => boolean): number {
    let pixels = 0
    for (const slice of this.slices.values()) {
      for (const { canvas } of slice.chunks.values()) {
        if (include(canvas)) pixels += canvas.width * canvas.height
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
    let hidden = this.cachedPixels(canvas => !this.attached.has(canvas))
    for (const slice of this.slices.values()) {
      if (hidden <= MAX_HIDDEN_CHUNK_PIXELS) return
      for (const [key, { canvas }] of slice.chunks) {
        if (this.attached.has(canvas)) continue
        hidden -= canvas.width * canvas.height
        slice.chunks.delete(key)
      }
    }
  }
}

const pixelColors = new Map<string, number>()

/** A '#rrggbb' colour scaled by `shade`, as an opaque RGBA pixel (little-endian Uint32). */
function pixelColor(color: string, shade: number): number {
  const key = `${color}:${String(shade)}`
  let result = pixelColors.get(key)
  if (result === undefined) {
    const [r, g, b] = [1, 3, 5].map(i => Math.round(parseInt(color.slice(i, i + 2), 16) * shade))
    result = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0
    pixelColors.set(key, result)
  }
  return result
}
