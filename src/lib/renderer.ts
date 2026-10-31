import { selectSlices, clampDepthMultiplier, DEFAULT_DEPTH_MULTIPLIER } from './slice-selection'
import { World, type Voxel, type WorldType } from './world'

export interface Camera {
  x: number
  y: number
  z: number
}

export const DEFAULT_CAMERA: Readonly<Camera> = { x: 0, y: 15, z: -30 }

export interface Layer {
  /** First world z covered by this slice. */
  depth: number
  /** Thickness in z units; the slice covers [depth, depth + size). */
  size: number
  voxels: Voxel[]
  canvas: HTMLCanvasElement
  visible: boolean
}

export interface UpdateStats {
  renderTime: number
  layerCount: number
  layersReused: number
  layersRegenerated: number
  voxelsRendered: number
  /** Percentage of visible layers served from the cache. */
  cacheEfficiency: number
}

export interface SessionStats {
  totalUpdates: number
  totalRenderTime: number
  totalLayersRegenerated: number
  totalVoxelsRendered: number
  averageCacheEfficiency: number
  lastUpdate: UpdateStats | null
}

// Perspective: pixels per world unit at viewing distance d is
// PROJECTION_SCALE_FACTOR / d (i.e. the focal length in pixels).
const PROJECTION_SCALE_FACTOR = 600

// Pixels per world unit used when rasterising a slice canvas. The canvas is
// rendered camera-independently at this fixed scale so its content can be
// cached and reused as the camera moves; perspective scaling is then applied
// via a CSS transform at composite time.
const RENDER_SCALE = 10

// Visible depth range, relative to the camera.
const NEAR_DEPTH = 1
const FAR_DEPTH = 200

// Maximum number of layers retained in the cache. Slices outside the
// currently-visible range are kept around (without DOM elements) so that
// reversing direction reuses their canvases instead of re-rendering. Each
// retained canvas holds a viewport-sized bitmap, so this bounds memory use
// (~30 MB at a 1080p viewport, which is ample for direction-reversal reuse
// given the slice algorithm only emits ~10 visible layers per frame).
const MAX_CACHED_LAYERS = 32

const BACKGROUND_COLOR = '#0a0a15'
const FOG_RGB = '10, 10, 21'

interface LayerElements {
  canvas: HTMLCanvasElement
  fog: HTMLDivElement
}

function layerKey(depth: number, size: number): string {
  return `${String(depth)}:${String(size)}`
}

/**
 * Renders a World as a stack of flat, cached slice canvases composited by
 * the browser. See DESIGN.md for the slicing and caching scheme.
 */
export class ParallaxRenderer {
  private container: HTMLElement
  private world: World
  private camera: Camera = { ...DEFAULT_CAMERA }
  private depthMultiplier = DEFAULT_DEPTH_MULTIPLIER
  private width: number
  private height: number

  // Keyed by layerKey(depth, size): slices of different sizes at the same
  // depth (which happen across camera positions) are cached separately.
  // Map insertion order doubles as LRU order (oldest first).
  private layers = new Map<string, Layer>()
  // Layers with DOM elements are exactly the layers visible this frame.
  private layerElements = new Map<string, LayerElements>()

  private stats: SessionStats = {
    totalUpdates: 0,
    totalRenderTime: 0,
    totalLayersRegenerated: 0,
    totalVoxelsRendered: 0,
    averageCacheEfficiency: 0,
    lastUpdate: null,
  }

  constructor(container: HTMLElement, world: World) {
    this.container = container
    this.container.style.backgroundColor = BACKGROUND_COLOR
    this.width = container.clientWidth
    this.height = container.clientHeight
    this.world = world
  }

  render() {
    const startTime = performance.now()

    // Far to near, so nearer layers stack on top.
    const slices = selectSlices(this.camera.z, NEAR_DEPTH, FAR_DEPTH, this.depthMultiplier).reverse()
    const requiredKeys = new Set(slices.map(s => layerKey(s.depth, s.size)))

    // Hide layers that left the view; their canvases stay cached.
    for (const key of Array.from(this.layerElements.keys())) {
      if (!requiredKeys.has(key)) this.removeLayerElements(key)
    }

    let layersRegenerated = 0
    let layersReused = 0
    let voxelsRendered = 0

    slices.forEach((slice, index) => {
      const key = layerKey(slice.depth, slice.size)
      let layer = this.layers.get(key)
      if (layer) {
        // Re-insert to mark as most recently used.
        this.layers.delete(key)
        layersReused++
      } else {
        layer = this.createLayer(slice.depth, slice.size)
        voxelsRendered += layer.voxels.length
        layersRegenerated++
      }
      this.layers.set(key, layer)

      let elements = this.layerElements.get(key)
      if (!elements) {
        elements = this.createLayerElements(layer)
        this.layerElements.set(key, elements)
      }
      this.composite(layer, elements, index)
    })

    this.evictLeastRecentlyUsed()

    const renderTime = performance.now() - startTime
    const cacheEfficiency = slices.length > 0 ? (layersReused / slices.length) * 100 : 0
    const s = this.stats
    s.totalUpdates++
    s.totalRenderTime += renderTime
    s.totalLayersRegenerated += layersRegenerated
    s.totalVoxelsRendered += voxelsRendered
    s.averageCacheEfficiency += (cacheEfficiency - s.averageCacheEfficiency) / s.totalUpdates
    s.lastUpdate = {
      renderTime,
      layerCount: slices.length,
      layersReused,
      layersRegenerated,
      voxelsRendered,
      cacheEfficiency,
    }
  }

  getCamera(): Camera {
    return { ...this.camera }
  }

  setCamera(camera: Partial<Camera>) {
    this.camera = { ...this.camera, ...camera }
  }

  getStats(): SessionStats {
    return { ...this.stats }
  }

  resize(width: number, height: number) {
    this.width = width
    this.height = height
    // Canvas dimensions are baked into each layer, so rebuild everything.
    this.clearAllLayers()
  }

  regenerateWorld(seed?: number, worldType?: WorldType) {
    this.world = new World(seed, worldType)
    this.clearAllLayers()
  }

  setDepthMultiplier(multiplier: number) {
    this.depthMultiplier = clampDepthMultiplier(multiplier)
    // Slice boundaries depend on the multiplier, so cached keys are stale.
    this.clearAllLayers()
  }

  /** Layers visible in the most recent render, sorted near to far. */
  getLayers(): Layer[] {
    const result: Layer[] = []
    for (const key of this.layerElements.keys()) {
      const layer = this.layers.get(key)
      if (layer) result.push(layer)
    }
    return result.sort((a, b) => a.depth - b.depth)
  }

  /** Toggles the visible layer starting at `depth` (visible slices never share a depth). */
  toggleLayerVisibility(depth: number) {
    const layer = this.getLayers().find(l => l.depth === depth)
    if (layer) layer.visible = !layer.visible
  }

  private clearAllLayers() {
    for (const key of Array.from(this.layerElements.keys())) {
      this.removeLayerElements(key)
    }
    this.layers.clear()
  }

  /** Creates a slice canvas and rasterises its voxels at RENDER_SCALE. */
  private createLayer(depth: number, size: number): Layer {
    const canvas = document.createElement('canvas')
    canvas.width = this.width
    canvas.height = this.height
    const voxels = this.world.getVoxelsInZRange(depth, depth + size)

    const ctx = canvas.getContext('2d')
    if (ctx) {
      // World origin maps to the canvas centre. Squares are drawn slightly
      // oversized so adjacent voxels don't leave hairline seams.
      const cx = canvas.width / 2
      const cy = canvas.height / 2
      const px = RENDER_SCALE * 1.1
      // Back to front within the slice.
      const sorted = voxels.slice().sort((a, b) => b.z - a.z)
      for (const v of sorted) {
        ctx.fillStyle = v.color
        ctx.fillRect(cx + v.x * RENDER_SCALE - px / 2, cy - v.y * RENDER_SCALE - px / 2, px, px)
      }
    }

    return { depth, size, voxels, canvas, visible: true }
  }

  /** Attaches a layer's canvas plus a fog overlay to the container. */
  private createLayerElements(layer: Layer): LayerElements {
    const canvas = layer.canvas
    Object.assign(canvas.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      transformOrigin: '50% 50%',
      willChange: 'transform',
      pointerEvents: 'none',
    })

    const fog = document.createElement('div')
    Object.assign(fog.style, { position: 'absolute', inset: '0', pointerEvents: 'none' })

    this.container.append(canvas, fog)
    return { canvas, fog }
  }

  private removeLayerElements(key: string) {
    const elements = this.layerElements.get(key)
    if (!elements) return
    elements.canvas.remove()
    elements.fog.remove()
    this.layerElements.delete(key)
  }

  /**
   * Positions a cached canvas for the current camera: scale for perspective
   * and translate for parallax. Only CSS changes here, never pixels.
   */
  private composite(layer: Layer, { canvas, fog }: LayerElements, stackIndex: number) {
    canvas.style.zIndex = String(stackIndex * 2)
    fog.style.zIndex = String(stackIndex * 2 + 1)

    if (!layer.visible) {
      canvas.style.display = 'none'
      fog.style.display = 'none'
      return
    }

    // Slices start at least NEAR_DEPTH ahead of the camera, so this is > 0.
    const viewingDistance = layer.depth + layer.size / 2 - this.camera.z
    const perspectiveScale = PROJECTION_SCALE_FACTOR / viewingDistance
    const offsetX = -this.camera.x * perspectiveScale
    const offsetY = this.camera.y * perspectiveScale
    canvas.style.transform =
      `translate3d(${String(offsetX)}px, ${String(offsetY)}px, 0) scale(${String(perspectiveScale / RENDER_SCALE)})`
    canvas.style.display = ''

    const fogIntensity = Math.min(0.15, viewingDistance / 500)
    if (fogIntensity > 0.01) {
      fog.style.backgroundColor = `rgba(${FOG_RGB}, ${String(fogIntensity)})`
      fog.style.display = ''
    } else {
      fog.style.display = 'none'
    }
  }

  /**
   * Drops least-recently-used layers until the cache fits MAX_CACHED_LAYERS.
   * Visible layers are never evicted, so the cap only bounds the hidden tail.
   */
  private evictLeastRecentlyUsed() {
    for (const key of Array.from(this.layers.keys())) {
      if (this.layers.size <= MAX_CACHED_LAYERS) return
      if (!this.layerElements.has(key)) this.layers.delete(key)
    }
  }
}
