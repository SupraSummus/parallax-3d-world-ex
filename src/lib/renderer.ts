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

export class World {
  voxels: Voxel[] = []
  seed: number

  constructor(seed: number = Date.now()) {
    this.seed = seed
    this.generate()
  }

  private noise(x: number, y: number, z: number): number {
    const n = Math.sin(x * 12.9898 + y * 78.233 + z * 45.164 + this.seed * 0.001) * 43758.5453
    return n - Math.floor(n)
  }

  generate() {
    this.voxels = []
    const size = 40
    const heightMap: number[][] = []

    for (let x = -size; x < size; x++) {
      heightMap[x] = []
      for (let z = -size; z < size; z++) {
        const nx = (x / size) * 4
        const nz = (z / size) * 4
        
        let height = 0
        height += this.noise(nx * 1, 0, nz * 1) * 8
        height += this.noise(nx * 2, 0, nz * 2) * 4
        height += this.noise(nx * 4, 0, nz * 4) * 2
        
        heightMap[x][z] = Math.floor(height)
      }
    }

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

        if (this.noise(x * 0.3, 0, z * 0.3) > 0.7 && groundHeight > 2) {
          const treeHeight = 4 + Math.floor(this.noise(x, 0, z) * 3)
          for (let y = groundHeight + 1; y < groundHeight + treeHeight; y++) {
            this.voxels.push({ x, y, z, color: '#654321', type: 4 })
          }
          
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

  getVoxelsInDepthRange(minZ: number, maxZ: number, camera: Camera): Voxel[] {
    return this.voxels.filter(voxel => {
      const relZ = voxel.z - camera.z
      return relZ >= minZ && relZ < maxZ
    })
  }
}

export class ParallaxRenderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private world: World
  private camera: Camera
  private layers: Map<number, Layer> = new Map()
  private lastCachePosition: Camera
  private sessionStats: SessionStats
  private updateStartTime: number = 0

  constructor(canvas: HTMLCanvasElement, world: World) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    this.world = world
    this.camera = { x: 0, y: 15, z: -30 }
    this.lastCachePosition = { ...this.camera }
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

  private invalidateCache() {
    this.layers.forEach(layer => {
      layer.dirty = true
    })
  }

  private invalidateCacheWithMiss() {
    this.invalidateCache()
  }

  private needsCacheRefresh(): boolean {
    const threshold = 0.5
    const positionChanged = Math.abs(this.camera.z - this.lastCachePosition.z) > threshold
    return positionChanged
  }

  private createLayer(depth: number, size: number = 1): Layer {
    const layerCanvas = document.createElement('canvas')
    layerCanvas.width = this.canvas.width
    layerCanvas.height = this.canvas.height
    
    return {
      depth,
      size,
      voxels: [],
      canvas: layerCanvas,
      dirty: true,
      visible: true
    }
  }

  private projectVoxel(voxel: Voxel, camera: Camera): { x: number; y: number; size: number; depth: number } | null {
    const dx = voxel.x - camera.x
    const dy = voxel.y - camera.y
    const dz = voxel.z - camera.z

    if (dz <= 0.1) return null

    const scale = 600 / dz
    const screenX = this.canvas.width / 2 + dx * scale
    const screenY = this.canvas.height / 2 - dy * scale
    const size = Math.max(1, scale * 0.8)

    return { x: screenX, y: screenY, size, depth: dz }
  }

  private renderLayerToCanvas(layer: Layer) {
    const ctx = layer.canvas.getContext('2d')!
    ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height)

    const minZ = layer.depth
    const maxZ = layer.depth + layer.size
    layer.voxels = this.world.getVoxelsInDepthRange(minZ, maxZ, this.lastCachePosition)

    const projected = layer.voxels
      .map(voxel => {
        const proj = this.projectVoxel(voxel, this.lastCachePosition)
        return proj ? { ...proj, color: voxel.color } : null
      })
      .filter(p => p !== null)
      .sort((a, b) => b!.depth - a!.depth)

    projected.forEach(p => {
      if (p) {
        ctx.fillStyle = p.color
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size)
      }
    })

    layer.dirty = false
    return projected.length
  }

  private roundToLayerBoundary(z: number, layerSize: number): number {
    return Math.floor(z / layerSize) * layerSize
  }

  private getLayerBoundaries(): { depth: number; size: number }[] {
    const boundaries: { depth: number; size: number }[] = []
    
    const powersOf2 = [1, 2, 4, 8, 16, 32, 64]
    
    for (const size of powersOf2) {
      const roundedZ = this.roundToLayerBoundary(this.camera.z, size)
      
      for (let i = -2; i <= 5; i++) {
        const depth = roundedZ + i * size
        if (depth > 0 && depth < 200) {
          const exists = boundaries.some(b => b.depth === depth)
          if (!exists) {
            boundaries.push({ depth, size })
          }
        }
      }
    }
    
    return boundaries.sort((a, b) => a.depth - b.depth)
  }

  private updateLayers() {
    const boundaries = this.getLayerBoundaries()
    const requiredKeys = boundaries.map(b => b.depth)

    const existingKeys = Array.from(this.layers.keys())
    existingKeys.forEach(key => {
      if (!requiredKeys.includes(key)) {
        this.layers.delete(key)
      }
    })

    boundaries.forEach(({ depth, size }) => {
      if (!this.layers.has(depth)) {
        const layer = this.createLayer(depth, size)
        layer.dirty = true
        this.layers.set(depth, layer)
      }
    })

    if (this.needsCacheRefresh()) {
      this.lastCachePosition = { ...this.camera }
      this.invalidateCache()
      this.sessionStats.cacheMisses++
      return { cacheRefreshed: true }
    }
    
    this.sessionStats.cacheHits++
    return { cacheRefreshed: false }
  }

  render() {
    this.updateStartTime = performance.now()
    
    const updateInfo = this.updateLayers()
    
    this.ctx.fillStyle = '#0a0a15'
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)

    const sortedLayers = Array.from(this.layers.values()).sort((a, b) => b.depth - a.depth)
    
    let layersRegenerated = 0
    let layersReused = 0
    let totalVoxels = 0

    sortedLayers.forEach(layer => {
      if (layer.dirty) {
        const voxelCount = this.renderLayerToCanvas(layer)
        totalVoxels += voxelCount
        layersRegenerated++
      } else {
        layersReused++
      }

      if (layer.visible) {
        const offsetX = (this.camera.x - this.lastCachePosition.x) * (300 / (layer.depth + 50))
        const offsetY = (this.camera.y - this.lastCachePosition.y) * (300 / (layer.depth + 50))

        this.ctx.globalAlpha = Math.max(0.3, 1 - (layer.depth / 100))
        this.ctx.drawImage(layer.canvas, offsetX, offsetY)
        this.ctx.globalAlpha = 1
      }
    })

    const renderTime = performance.now() - this.updateStartTime
    const totalLayers = sortedLayers.length
    const cacheEfficiency = totalLayers > 0 ? (layersReused / totalLayers) * 100 : 0
    
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
    this.canvas.width = width
    this.canvas.height = height
    this.invalidateCacheWithMiss()
  }

  regenerateWorld(seed?: number) {
    this.world = new World(seed)
    this.invalidateCacheWithMiss()
  }

  getLayers(): Layer[] {
    return Array.from(this.layers.values()).sort((a, b) => a.depth - b.depth)
  }

  toggleLayerVisibility(depth: number) {
    const layer = this.layers.get(depth)
    if (layer) {
      layer.visible = !layer.visible
    }
  }

  setLayerVisibility(depth: number, visible: boolean) {
    const layer = this.layers.get(depth)
    if (layer) {
      layer.visible = visible
    }
  }
}
