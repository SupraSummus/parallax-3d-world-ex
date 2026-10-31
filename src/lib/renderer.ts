import { selectSlices, clampDetail, DEFAULT_DETAIL } from './slice-selection'
import { World, type Voxel, type WorldType } from './world'

export interface Camera {
  x: number
  y: number
  z: number
}

export const DEFAULT_CAMERA: Readonly<Camera> = { x: 0, y: 20, z: -70 }

export interface Layer {
  /** First world z covered by this slice. */
  depth: number
  /** Thickness in z units; the slice covers [depth, depth + size). */
  size: number
  /** All voxels in the slice (most are hidden behind nearer ones). */
  voxels: Voxel[]
  /** Number of voxel faces actually drawn on the canvas. */
  facesDrawn: number
  /** Cropped to the slice's content; see originX/originY. */
  canvas: HTMLCanvasElement
  /** World x, y of the canvas's top-left corner. */
  originX: number
  originY: number
  visible: boolean
}

export interface UpdateStats {
  renderTime: number
  layerCount: number
  layersReused: number
  layersRegenerated: number
  /** Voxel faces drawn into newly rasterised layers. */
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
// reversing direction reuses their canvases instead of re-rendering. A canvas
// is at most the world's extent at RENDER_SCALE (~1 MB), so this bounds
// memory to a few tens of MB.
const MAX_CACHED_LAYERS = 32

// Sky gradient; the horizon sits at eye level (screen centre).
const SKY_TOP = '#3f73b8'
const SKY_HORIZON = '#b9d3e8'
// Exponential distance fog towards the horizon colour: at viewing distance d
// a voxel keeps exp(-d / FOG_DISTANCE) of its own colour.
const FOG_RGB = '185, 211, 232'
const FOG_DISTANCE = 140

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
  private detail = DEFAULT_DETAIL
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
    this.container.style.background = `linear-gradient(${SKY_TOP}, ${SKY_HORIZON} 50%)`
    this.width = container.clientWidth
    this.height = container.clientHeight
    this.world = world
  }

  render() {
    const startTime = performance.now()

    // Far to near, so nearer layers stack on top.
    const slices = selectSlices(this.camera.z, NEAR_DEPTH, FAR_DEPTH, this.detail).reverse()
    const requiredKeys = new Set(slices.map(s => layerKey(s.depth, s.size)))

    // Hide layers that left the view; their canvases stay cached.
    for (const key of Array.from(this.layerElements.keys())) {
      if (!requiredKeys.has(key)) this.removeLayerElements(key)
    }

    let layersRegenerated = 0
    let layersReused = 0
    let voxelsRendered = 0

    // Fog overlays stack: the overlay above slice k also tints every slice
    // behind it. Give each overlay the fog of the depth interval between the
    // previous (nearer) slice and its own, so the accumulated fog at any
    // slice is exactly 1 - exp(-d / FOG_DISTANCE).
    const distances = slices.map(s => s.depth + s.size / 2 - this.camera.z)

    slices.forEach((slice, index) => {
      const key = layerKey(slice.depth, slice.size)
      let layer = this.layers.get(key)
      if (layer) {
        // Re-insert to mark as most recently used.
        this.layers.delete(key)
        layersReused++
      } else {
        layer = this.createLayer(slice.depth, slice.size)
        voxelsRendered += layer.facesDrawn
        layersRegenerated++
      }
      this.layers.set(key, layer)

      let elements = this.layerElements.get(key)
      if (!elements) {
        elements = this.createLayerElements(layer)
        this.layerElements.set(key, elements)
      }
      const nearerDistance = index + 1 < distances.length ? distances[index + 1] : 0
      const fogAlpha = 1 - Math.exp(-(distances[index] - nearerDistance) / FOG_DISTANCE)
      this.composite(layer, elements, index, distances[index], fogAlpha)
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

  /** Sets the viewport size. Cached layers stay valid; call render() to reposition them. */
  resize(width: number, height: number) {
    this.width = width
    this.height = height
  }

  regenerateWorld(seed?: number, worldType?: WorldType) {
    this.world = new World(seed, worldType)
    this.clearAllLayers()
  }

  /** Sets slice detail (see slice-selection.ts). Slices are keyed by depth and size, so the cache stays valid. */
  setDetail(detail: number) {
    this.detail = clampDetail(detail)
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

  /**
   * Creates a slice canvas and rasterises its voxels at RENDER_SCALE.
   *
   * The projection within a slice is orthographic, so for each (x, y) cell
   * only the nearest voxel can be seen; only that one is drawn. Voxel
   * (x, y) covers [x - 0.5, x + 0.5] × [y - 0.5, y + 0.5].
   */
  private createLayer(depth: number, size: number): Layer {
    const voxels = this.world.getVoxelsInZRange(depth, depth + size)

    const front = new Map<number, Voxel>()
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const v of voxels) {
      const key = (v.x + 512) * 1024 + (v.y + 512)
      const current = front.get(key)
      if (!current || v.z < current.z) front.set(key, v)
      minX = Math.min(minX, v.x)
      maxX = Math.max(maxX, v.x)
      minY = Math.min(minY, v.y)
      maxY = Math.max(maxY, v.y)
    }

    const canvas = document.createElement('canvas')
    const empty = front.size === 0
    const layer: Layer = {
      depth,
      size,
      voxels,
      facesDrawn: front.size,
      canvas,
      originX: empty ? 0 : minX - 0.5,
      originY: empty ? 0 : maxY + 0.5,
      visible: true,
    }
    if (empty) {
      canvas.width = canvas.height = 0
      return layer
    }

    canvas.width = (maxX - minX + 1) * RENDER_SCALE
    canvas.height = (maxY - minY + 1) * RENDER_SCALE
    const ctx = canvas.getContext('2d')
    if (!ctx) return layer

    const edge = Math.max(1, Math.round(RENDER_SCALE / 10))
    for (const v of front.values()) {
      const px = (v.x - minX) * RENDER_SCALE
      const py = (maxY - v.y) * RENDER_SCALE
      const shades = shadesOf(v.color)
      ctx.fillStyle = shades.base
      ctx.fillRect(px, py, RENDER_SCALE, RENDER_SCALE)
      // Darker bottom/right edges outline individual voxels.
      ctx.fillStyle = shades.dark
      ctx.fillRect(px, py + RENDER_SCALE - edge, RENDER_SCALE, edge)
      ctx.fillRect(px + RENDER_SCALE - edge, py, edge, RENDER_SCALE)
      // Lit top edge where the voxel's top face is exposed to the sky.
      if (!this.world.has(v.x, v.y + 1, v.z)) {
        ctx.fillStyle = shades.light
        ctx.fillRect(px, py, RENDER_SCALE, edge * 2)
      }
    }

    return layer
  }

  /** Attaches a layer's canvas plus a fog overlay to the container. */
  private createLayerElements(layer: Layer): LayerElements {
    const canvas = layer.canvas
    Object.assign(canvas.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      transformOrigin: '0 0',
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
  private composite(
    layer: Layer,
    { canvas, fog }: LayerElements,
    stackIndex: number,
    viewingDistance: number,
    fogAlpha: number,
  ) {
    canvas.style.zIndex = String(stackIndex * 2)
    fog.style.zIndex = String(stackIndex * 2 + 1)
    // Fog stays even for hidden layers so the slices behind keep their haze.
    fog.style.backgroundColor = `rgba(${FOG_RGB}, ${fogAlpha.toFixed(4)})`

    if (!layer.visible || layer.facesDrawn === 0) {
      canvas.style.display = 'none'
      return
    }
    canvas.style.display = ''

    // Slices start at least NEAR_DEPTH ahead of the camera, so this is > 0.
    const scale = PROJECTION_SCALE_FACTOR / viewingDistance
    const left = this.width / 2 + (layer.originX - this.camera.x) * scale
    const top = this.height / 2 - (layer.originY - this.camera.y) * scale
    canvas.style.transform =
      `translate3d(${String(left)}px, ${String(top)}px, 0) scale(${String(scale / RENDER_SCALE)})`
    // Keep voxel edges crisp when magnified; smooth when minified.
    canvas.style.imageRendering = scale > RENDER_SCALE ? 'pixelated' : 'auto'
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

interface Shades {
  base: string
  light: string
  dark: string
}

const shadeCache = new Map<string, Shades>()

/** Base, lit and shadowed variants of a '#rrggbb' colour. */
function shadesOf(color: string): Shades {
  let shades = shadeCache.get(color)
  if (!shades) {
    const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16))
    const mix = (target: number, amount: number) =>
      `rgb(${rgb.map(c => String(Math.round(c + (target - c) * amount))).join(', ')})`
    shades = { base: color, light: mix(255, 0.3), dark: mix(0, 0.25) }
    shadeCache.set(color, shades)
  }
  return shades
}
