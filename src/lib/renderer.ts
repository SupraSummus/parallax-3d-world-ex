import { selectSlices, DEFAULT_DEPTH_MULTIPLIER } from './slice-selection'

// Projection scale factor: determines the size of voxels relative to their distance
// Higher values = larger voxels at the same depth
const PROJECTION_SCALE_FACTOR = 600

export interface Voxel {
  x: number
  y: number
  z: number
  color: string
  type: number
}

export interface Camera {
  x: number
  y: number
  z: number
}

export interface Layer {
  depth: number
  size: number
  voxels: Voxel[]
  canvas: HTMLCanvasElement
  dirty: boolean
  visible: boolean
}

export interface UpdateStats {
  renderTime: number
  layerCount: number
  layersReused: number
  layersRegenerated: number
  voxelsRendered: number
  cacheEfficiency: number
  timestamp: number
}

export interface SessionStats {
  totalUpdates: number
  totalRenderTime: number
  totalLayersRegenerated: number
  totalVoxelsRendered: number
  averageCacheEfficiency: number
  lastUpdate: UpdateStats | null
  layerCount: number
  voxelsRendered: number
  cacheHits: number
  cacheMisses: number
  fps: number
  frameTime: number
}

export type WorldType = 'forest' | 'hills' | 'mountains' | 'hills_with_trees' | 'lake_with_island'

export const WORLD_TYPES: { value: WorldType; label: string }[] = [
  { value: 'forest', label: 'Forest' },
  { value: 'hills', label: 'Hills' },
  { value: 'mountains', label: 'Mountains' },
  { value: 'hills_with_trees', label: 'Hills with Trees' },
  { value: 'lake_with_island', label: 'Lake with Island' }
]

export class World {
  voxels: Voxel[] = []
  seed: number
  worldType: WorldType

  constructor(seed: number = Date.now(), worldType: WorldType = 'forest') {
    this.seed = seed
    this.worldType = worldType
    this.generate()
  }

  private noise(x: number, y: number, z: number): number {
    const n = Math.sin(x * 12.9898 + y * 78.233 + z * 45.164 + this.seed * 0.001) * 43758.5453
    return n - Math.floor(n)
  }

  generate() {
    this.voxels = []
    
    switch (this.worldType) {
      case 'forest':
        this.generateForest()
        break
      case 'hills':
        this.generateHills()
        break
      case 'mountains':
        this.generateMountains()
        break
      case 'hills_with_trees':
        this.generateHillsWithTrees()
        break
      case 'lake_with_island':
        this.generateLakeWithIsland()
        break
      default:
        this.generateForest()
    }
  }

  private generateTerrain(size: number, heightMultiplier: number): number[][] {
    const heightMap: number[][] = []
    for (let x = -size; x < size; x++) {
      heightMap[x] = []
      for (let z = -size; z < size; z++) {
        const nx = (x / size) * 4
        const nz = (z / size) * 4
        
        let height = 0
        height += this.noise(nx * 1, 0, nz * 1) * 8 * heightMultiplier
        height += this.noise(nx * 2, 0, nz * 2) * 4 * heightMultiplier
        height += this.noise(nx * 4, 0, nz * 4) * 2 * heightMultiplier
        
        heightMap[x][z] = Math.floor(height)
      }
    }
    return heightMap
  }

  private addTree(x: number, groundHeight: number, z: number, treeHeight: number) {
    // Trunk
    for (let y = groundHeight + 1; y < groundHeight + treeHeight; y++) {
      this.voxels.push({ x, y, z, color: '#654321', type: 4 })
    }
    // Leaves
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dy = 0; dy < 3; dy++) {
          if (Math.abs(dx) + Math.abs(dz) + dy < 4) {
            this.voxels.push({
              x: x + dx,
              y: groundHeight + treeHeight - 1 + dy,
              z: z + dz,
              color: '#228B22',
              type: 5
            })
          }
        }
      }
    }
  }

  private generateForest() {
    const size = 40
    const heightMap = this.generateTerrain(size, 1)

    for (let x = -size; x < size; x++) {
      for (let z = -size; z < size; z++) {
        const groundHeight = heightMap[x][z]
        
        for (let y = -5; y <= groundHeight; y++) {
          let color: string
          let type: number
          
          if (y === groundHeight) {
            color = '#4CAF50'
            type = 1
          } else if (y > groundHeight - 3) {
            color = '#8B4513'
            type = 2
          } else {
            color = '#666666'
            type = 3
          }
          
          this.voxels.push({ x, y, z, color, type })
        }

        // Dense tree coverage for forest
        if (this.noise(x * 0.3, 0, z * 0.3) > 0.6 && groundHeight > 2) {
          const treeHeight = 4 + Math.floor(this.noise(x, 0, z) * 3)
          this.addTree(x, groundHeight, z, treeHeight)
        }

        // Flowers
        if (this.noise(x * 0.5, 50, z * 0.5) > 0.85) {
          this.voxels.push({
            x,
            y: groundHeight + 1,
            z,
            color: '#FFD700',
            type: 6
          })
        }
      }
    }
  }

  private generateHills() {
    const size = 40
    const heightMap = this.generateTerrain(size, 0.7)

    for (let x = -size; x < size; x++) {
      for (let z = -size; z < size; z++) {
        const groundHeight = heightMap[x][z]
        
        for (let y = -5; y <= groundHeight; y++) {
          let color: string
          let type: number
          
          if (y === groundHeight) {
            color = '#7CFC00'  // Bright grass
            type = 1
          } else if (y > groundHeight - 3) {
            color = '#8B4513'
            type = 2
          } else {
            color = '#666666'
            type = 3
          }
          
          this.voxels.push({ x, y, z, color, type })
        }

        // Occasional flowers on hills
        if (this.noise(x * 0.4, 30, z * 0.4) > 0.8) {
          const flowerColors = ['#FF6B6B', '#FFE66D', '#4ECDC4', '#C9B1FF']
          const colorIndex = Math.floor(this.noise(x, z, 0) * flowerColors.length)
          this.voxels.push({
            x,
            y: groundHeight + 1,
            z,
            color: flowerColors[colorIndex],
            type: 6
          })
        }
      }
    }
  }

  private generateMountains() {
    const size = 40
    const heightMap = this.generateTerrain(size, 2.5)

    for (let x = -size; x < size; x++) {
      for (let z = -size; z < size; z++) {
        const groundHeight = heightMap[x][z]
        
        for (let y = -5; y <= groundHeight; y++) {
          let color: string
          let type: number
          
          if (y > 15) {
            // Snow caps
            color = '#FFFFFF'
            type = 7
          } else if (y === groundHeight && y > 8) {
            // Rocky peaks
            color = '#808080'
            type = 3
          } else if (y === groundHeight) {
            color = '#4CAF50'
            type = 1
          } else if (y > groundHeight - 3) {
            color = '#8B4513'
            type = 2
          } else {
            color = '#555555'
            type = 3
          }
          
          this.voxels.push({ x, y, z, color, type })
        }
      }
    }
  }

  private generateHillsWithTrees() {
    const size = 40
    const heightMap = this.generateTerrain(size, 0.8)

    for (let x = -size; x < size; x++) {
      for (let z = -size; z < size; z++) {
        const groundHeight = heightMap[x][z]
        
        for (let y = -5; y <= groundHeight; y++) {
          let color: string
          let type: number
          
          if (y === groundHeight) {
            color = '#4CAF50'
            type = 1
          } else if (y > groundHeight - 3) {
            color = '#8B4513'
            type = 2
          } else {
            color = '#666666'
            type = 3
          }
          
          this.voxels.push({ x, y, z, color, type })
        }

        // Scattered trees on hills
        if (this.noise(x * 0.3, 0, z * 0.3) > 0.75 && groundHeight > 2) {
          const treeHeight = 4 + Math.floor(this.noise(x, 0, z) * 3)
          this.addTree(x, groundHeight, z, treeHeight)
        }
      }
    }
  }

  private generateLakeWithIsland() {
    const size = 40
    const heightMap = this.generateTerrain(size, 0.6)

    for (let x = -size; x < size; x++) {
      for (let z = -size; z < size; z++) {
        const distFromCenter = Math.sqrt(x * x + z * z)
        const groundHeight = heightMap[x][z]
        
        // Create a lake depression in the center
        const isLake = distFromCenter > 8 && distFromCenter < 25
        const isIsland = distFromCenter <= 8
        
        if (isLake) {
          // Water
          for (let y = -5; y <= 0; y++) {
            if (y < 0) {
              this.voxels.push({ x, y, z, color: '#666666', type: 3 })
            } else {
              this.voxels.push({ x, y, z, color: '#1E90FF', type: 8 })
            }
          }
        } else if (isIsland) {
          // Island in the center
          const islandHeight = groundHeight + 3
          for (let y = -5; y <= islandHeight; y++) {
            let color: string
            let type: number
            
            if (y === islandHeight) {
              color = '#90EE90'
              type = 1
            } else if (y > islandHeight - 3) {
              color = '#C4A76D'  // Sandy soil
              type = 2
            } else {
              color = '#666666'
              type = 3
            }
            
            this.voxels.push({ x, y, z, color, type })
          }
          
          // Palm tree on island
          if (distFromCenter < 5 && this.noise(x * 0.5, 0, z * 0.5) > 0.7) {
            const treeHeight = 5 + Math.floor(this.noise(x, 0, z) * 2)
            for (let y = islandHeight + 1; y < islandHeight + treeHeight; y++) {
              this.voxels.push({ x, y, z, color: '#8B7355', type: 4 })
            }
            // Palm leaves
            for (let dx = -2; dx <= 2; dx++) {
              for (let dz = -2; dz <= 2; dz++) {
                if (Math.abs(dx) + Math.abs(dz) <= 2) {
                  this.voxels.push({
                    x: x + dx,
                    y: islandHeight + treeHeight,
                    z: z + dz,
                    color: '#32CD32',
                    type: 5
                  })
                }
              }
            }
          }
        } else {
          // Shore/beach
          for (let y = -5; y <= groundHeight; y++) {
            let color: string
            let type: number
            
            if (y === groundHeight && distFromCenter < 28) {
              color = '#F4D03F'  // Sand
              type = 9
            } else if (y === groundHeight) {
              color = '#4CAF50'
              type = 1
            } else if (y > groundHeight - 3) {
              color = '#8B4513'
              type = 2
            } else {
              color = '#666666'
              type = 3
            }
            
            this.voxels.push({ x, y, z, color, type })
          }
        }
      }
    }
  }

  getVoxelsInDepthRange(minZ: number, maxZ: number, camera: Camera): Voxel[] {
    return this.voxels.filter(voxel => {
      const relZ = voxel.z - camera.z
      return relZ >= minZ && relZ < maxZ
    })
  }

  /**
   * Get voxels in an absolute z-coordinate range (camera-independent).
   * Used for flat/orthographic layer rendering that can be cached.
   */
  getVoxelsInAbsoluteZRange(minZ: number, maxZ: number): Voxel[] {
    return this.voxels.filter(voxel => {
      return voxel.z >= minZ && voxel.z < maxZ
    })
  }
}

// Pixels per world unit used when rasterising a slice canvas. The canvas is
// rendered camera-independently at this fixed scale so its content can be
// cached and reused as the camera moves; perspective scaling is then applied
// via a CSS transform at composite time.
const RENDER_SCALE = 10

// Maximum number of layers retained in the cache. Slices outside the
// currently-visible range are kept around (without DOM elements) so that
// reversing direction reuses their canvases instead of re-rendering. Each
// retained canvas holds a viewport-sized bitmap, so this bounds memory use
// (~30 MB at a 1080p viewport, which is ample for direction-reversal reuse
// given the slice algorithm only emits ~10 visible layers per frame).
const MAX_CACHED_LAYERS = 32

function layerKey(depth: number, size: number): string {
  return `${String(depth)}:${String(size)}`
}

export class ParallaxRenderer {
  private container: HTMLElement
  private world: World
  private camera: Camera
  // Layers are keyed by (depth, size) so that slices of different sizes at the
  // same depth (which can happen across camera positions) are cached
  // separately. Insertion order is used as a recency hint for LRU eviction.
  private layers: Map<string, Layer> = new Map()
  // The keys of layerElements double as the set of currently-visible layers:
  // any layer with DOM elements is being painted this frame.
  private layerElements: Map<string, { canvas: HTMLCanvasElement; fog: HTMLDivElement }> = new Map()
  private sessionStats: SessionStats
  private updateStartTime: number = 0
  private depthMultiplier: number = DEFAULT_DEPTH_MULTIPLIER
  private width: number = 0
  private height: number = 0

  constructor(container: HTMLElement, world: World) {
    this.container = container
    this.container.style.backgroundColor = '#0a0a15'
    this.width = container.clientWidth || 0
    this.height = container.clientHeight || 0
    this.world = world
    this.camera = { x: 0, y: 15, z: -30 }
    this.sessionStats = {
      totalUpdates: 0,
      totalRenderTime: 0,
      totalLayersRegenerated: 0,
      totalVoxelsRendered: 0,
      averageCacheEfficiency: 0,
      lastUpdate: null,
      layerCount: 0,
      voxelsRendered: 0,
      cacheHits: 0,
      cacheMisses: 0,
      fps: 0,
      frameTime: 0
    }
  }

  /**
   * Discards every cached layer and its DOM elements. Used when the
   * underlying world content or canvas geometry actually changes (world
   * regeneration, viewport resize, or a new depth multiplier). Camera
   * movement does NOT call this — slice canvases are camera-independent.
   */
  private clearAllLayers() {
    Array.from(this.layerElements.keys()).forEach(key => {
      this.removeLayerElements(key)
    })
    this.layers.clear()
    this.sessionStats.cacheMisses++
  }

  private createLayer(depth: number, size: number = 1): Layer {
    const layerCanvas = document.createElement('canvas')
    layerCanvas.width = this.width
    layerCanvas.height = this.height

    return {
      depth,
      size,
      voxels: [],
      canvas: layerCanvas,
      dirty: true,
      visible: true
    }
  }

  /**
   * Perspective scale (pixels per world unit) for a slice at the given
   * viewing distance. This is applied at composite time as a CSS scale on
   * top of the canvas's fixed RENDER_SCALE.
   */
  private getProjectionScale(viewingDistance: number): number {
    return PROJECTION_SCALE_FACTOR / viewingDistance
  }

  /**
   * Renders the slice's voxels onto its canvas using a fixed world-to-pixel
   * scale (RENDER_SCALE). The output is camera-independent: the canvas
   * shows the same image whatever the camera does, so any subsequent camera
   * movement only updates CSS transforms and never invalidates the canvas.
   */
  private renderLayerToCanvas(layer: Layer): number {
    const ctx = layer.canvas.getContext('2d')
    if (!ctx) return 0
    ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height)

    const absoluteMinZ = layer.depth
    const absoluteMaxZ = layer.depth + layer.size
    layer.voxels = this.world.getVoxelsInAbsoluteZRange(absoluteMinZ, absoluteMaxZ)

    const cx = layer.canvas.width / 2
    const cy = layer.canvas.height / 2
    const voxelPixelSize = Math.max(1, RENDER_SCALE * 1.1)

    const projected = layer.voxels
      .map(voxel => ({
        x: cx + voxel.x * RENDER_SCALE,
        y: cy - voxel.y * RENDER_SCALE,
        zInLayer: voxel.z,
        color: voxel.color
      }))
      .sort((a, b) => b.zInLayer - a.zInLayer)

    projected.forEach(p => {
      ctx.fillStyle = p.color
      ctx.fillRect(p.x - voxelPixelSize / 2, p.y - voxelPixelSize / 2, voxelPixelSize, voxelPixelSize)
    })

    layer.dirty = false
    return projected.length
  }

  private getLayerBoundaries(): { depth: number; size: number }[] {
    // selectSlices ensures contiguous z coverage with no gaps.
    const minZ = 1
    const maxZ = 200
    return selectSlices(this.camera.z, minZ, maxZ, this.depthMultiplier)
  }

  /**
   * Creates DOM elements (canvas + fog overlay) for a layer and appends them
   * to the container.
   */
  private createLayerElements(layer: Layer, zIndex: number): { canvas: HTMLCanvasElement; fog: HTMLDivElement } {
    const canvas = layer.canvas
    canvas.style.position = 'absolute'
    canvas.style.left = '0'
    canvas.style.top = '0'
    canvas.style.transformOrigin = '50% 50%'
    canvas.style.willChange = 'transform'
    canvas.style.pointerEvents = 'none'
    canvas.style.zIndex = String(zIndex * 2)

    const fog = document.createElement('div')
    fog.style.position = 'absolute'
    fog.style.inset = '0'
    fog.style.pointerEvents = 'none'
    fog.style.zIndex = String(zIndex * 2 + 1)

    this.container.appendChild(canvas)
    this.container.appendChild(fog)

    return { canvas, fog }
  }

  private removeLayerElements(key: string) {
    const elements = this.layerElements.get(key)
    if (elements) {
      elements.canvas.remove()
      elements.fog.remove()
      this.layerElements.delete(key)
    }
  }

  /**
   * Marks the given key as most-recently-used by re-inserting it at the end
   * of the Map's iteration order.
   */
  private touchLayer(key: string) {
    const layer = this.layers.get(key)
    if (layer) {
      this.layers.delete(key)
      this.layers.set(key, layer)
    }
  }

  /**
   * Drops least-recently-used cached layers (and their DOM elements) until
   * the cache fits within MAX_CACHED_LAYERS. Currently-visible layers are
   * never evicted, so the cap only bounds the retained-but-hidden tail.
   */
  private enforceLruCap() {
    if (this.layers.size <= MAX_CACHED_LAYERS) return
    for (const key of Array.from(this.layers.keys())) {
      if (this.layers.size <= MAX_CACHED_LAYERS) break
      if (this.layerElements.has(key)) continue
      this.layers.delete(key)
    }
  }

  render() {
    this.updateStartTime = performance.now()

    const boundaries = this.getLayerBoundaries()
    const requiredKeys = new Set(boundaries.map(b => layerKey(b.depth, b.size)))

    let layersRegenerated = 0
    let layersReused = 0
    let totalVoxels = 0

    // Hide DOM elements for layers no longer in view; their canvases stay in
    // the cache so reversing direction will reuse them.
    Array.from(this.layerElements.keys()).forEach(key => {
      if (!requiredKeys.has(key)) {
        this.removeLayerElements(key)
      }
    })

    // Look up or create the layer for each required slice, render dirty
    // ones, and composite. Iterate from far to near so closer layers paint
    // on top.
    const sortedBoundaries = boundaries.slice().sort((a, b) => b.depth - a.depth)
    sortedBoundaries.forEach((boundary, index) => {
      const key = layerKey(boundary.depth, boundary.size)
      let layer = this.layers.get(key)
      if (!layer) {
        layer = this.createLayer(boundary.depth, boundary.size)
        this.layers.set(key, layer)
      } else {
        this.touchLayer(key)
      }

      const layerCenterZ = layer.depth + layer.size / 2
      const viewingDistance = layerCenterZ - this.camera.z
      if (viewingDistance <= 0.1) return

      if (layer.dirty) {
        totalVoxels += this.renderLayerToCanvas(layer)
        layersRegenerated++
      } else {
        layersReused++
      }

      let elements = this.layerElements.get(key)
      if (!elements) {
        elements = this.createLayerElements(layer, index)
        this.layerElements.set(key, elements)
      }

      elements.canvas.style.zIndex = String(index * 2)
      elements.fog.style.zIndex = String(index * 2 + 1)

      if (layer.visible) {
        // Composite: translate the canvas for parallax, scale for
        // perspective. Origin is canvas centre (which coincides with
        // viewport centre when canvas == viewport size).
        const perspectiveScale = this.getProjectionScale(viewingDistance)
        const cssScale = perspectiveScale / RENDER_SCALE
        const offsetX = -this.camera.x * perspectiveScale
        const offsetY = this.camera.y * perspectiveScale
        elements.canvas.style.transform =
          `translate3d(${String(offsetX)}px, ${String(offsetY)}px, 0) scale(${String(cssScale)})`
        elements.canvas.style.display = ''

        const fogIntensity = Math.min(0.15, viewingDistance / 500)
        if (fogIntensity > 0.01) {
          elements.fog.style.backgroundColor = `rgba(10, 10, 21, ${String(fogIntensity)})`
          elements.fog.style.display = ''
        } else {
          elements.fog.style.display = 'none'
        }
      } else {
        elements.canvas.style.display = 'none'
        elements.fog.style.display = 'none'
      }
    })

    this.enforceLruCap()

    const renderTime = performance.now() - this.updateStartTime
    const totalLayers = sortedBoundaries.length
    const cacheEfficiency = totalLayers > 0 ? (layersReused / totalLayers) * 100 : 0

    // Hits and misses can both happen in the same frame: e.g. when the
    // camera moves slightly along Z, far slices stay cached (hit) but a few
    // near slices get re-tiled at different sizes and regenerate (miss).
    if (layersReused > 0) this.sessionStats.cacheHits++
    if (layersRegenerated > 0) this.sessionStats.cacheMisses++

    const updateStats: UpdateStats = {
      renderTime,
      layerCount: totalLayers,
      layersReused,
      layersRegenerated,
      voxelsRendered: totalVoxels,
      cacheEfficiency,
      timestamp: Date.now()
    }

    this.sessionStats.totalUpdates++
    this.sessionStats.totalRenderTime += renderTime
    this.sessionStats.totalLayersRegenerated += layersRegenerated
    this.sessionStats.totalVoxelsRendered += totalVoxels
    this.sessionStats.averageCacheEfficiency =
      (this.sessionStats.averageCacheEfficiency * (this.sessionStats.totalUpdates - 1) + cacheEfficiency) /
      this.sessionStats.totalUpdates
    this.sessionStats.lastUpdate = updateStats

    this.sessionStats.layerCount = totalLayers
    this.sessionStats.voxelsRendered = totalVoxels
    this.sessionStats.frameTime = renderTime
    this.sessionStats.fps = renderTime > 0 ? Math.round(1000 / renderTime) : 0
  }

  getCamera(): Camera {
    return { ...this.camera }
  }

  setCamera(camera: Partial<Camera>) {
    this.camera = { ...this.camera, ...camera }
  }

  getSessionStats(): SessionStats {
    return { ...this.sessionStats }
  }

  getStats(): SessionStats {
    return this.getSessionStats()
  }

  resize(width: number, height: number) {
    this.width = width
    this.height = height
    // Canvas dimensions are baked into each layer at create time, so a
    // viewport resize forces a full rebuild.
    this.clearAllLayers()
  }

  regenerateWorld(seed?: number, worldType?: WorldType) {
    this.world = new World(seed, worldType)
    this.clearAllLayers()
  }

  getWorldType(): WorldType {
    return this.world.worldType
  }

  /**
   * Returns the layers visible in the most recent render, sorted by depth.
   * Cached-but-hidden layers are intentionally excluded so callers (UI
   * panels, tests) only see what's currently on screen.
   */
  getLayers(): Layer[] {
    const result: Layer[] = []
    this.layerElements.forEach((_, key) => {
      const layer = this.layers.get(key)
      if (layer) result.push(layer)
    })
    return result.sort((a, b) => a.depth - b.depth)
  }

  private findVisibleLayerByDepth(depth: number): Layer | undefined {
    for (const key of this.layerElements.keys()) {
      const layer = this.layers.get(key)
      if (layer && layer.depth === depth) return layer
    }
    return undefined
  }

  setLayerVisibility(depth: number, visible: boolean) {
    const layer = this.findVisibleLayerByDepth(depth)
    if (layer) layer.visible = visible
  }

  toggleLayerVisibility(depth: number) {
    const layer = this.findVisibleLayerByDepth(depth)
    if (layer) this.setLayerVisibility(depth, !layer.visible)
  }

  getDepthMultiplier(): number {
    return this.depthMultiplier
  }

  setDepthMultiplier(multiplier: number) {
    if (multiplier >= 1.2 && multiplier <= 4) {
      this.depthMultiplier = multiplier
      // Slice boundaries change with the multiplier, so previous (depth,
      // size) keys are no longer meaningful.
      this.clearAllLayers()
    }
  }
}
