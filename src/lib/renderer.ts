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

export class ParallaxRenderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private world: World
  private camera: Camera
  private layers: Map<number, Layer> = new Map()
  private lastCachePosition: Camera
  private sessionStats: SessionStats
  private updateStartTime: number = 0
  private depthMultiplier: number = DEFAULT_DEPTH_MULTIPLIER

  constructor(canvas: HTMLCanvasElement, world: World) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('Failed to get 2d context')
    }
    this.ctx = ctx
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
    this.sessionStats.cacheMisses++
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

  /**
   * Computes the projection scale for a given depth.
   * Used for both perspective and orthographic projection.
   */
  private getProjectionScale(depth: number): number {
    return PROJECTION_SCALE_FACTOR / depth
  }

  private projectVoxel(voxel: Voxel, camera: Camera): { x: number; y: number; size: number; depth: number } | null {
    const dx = voxel.x - camera.x
    const dy = voxel.y - camera.y
    const dz = voxel.z - camera.z

    if (dz <= 0.1) return null

    const scale = this.getProjectionScale(dz)
    const screenX = this.canvas.width / 2 + dx * scale
    const screenY = this.canvas.height / 2 - dy * scale
    const size = Math.max(1, scale * 0.8)

    return { x: screenX, y: screenY, size, depth: dz }
  }

  /**
   * Projects a voxel using orthographic (flat) projection.
   * This is camera-independent and used for rendering layers that can be cached.
   * The scale is fixed based on a reference depth (the layer's depth).
   */
  private projectVoxelFlat(voxel: Voxel, referenceDepth: number): { x: number; y: number; size: number; zInLayer: number } | null {
    if (referenceDepth <= 0.1) return null

    // Use a fixed orthographic scale based on the layer's reference depth
    const scale = this.getProjectionScale(referenceDepth)
    
    // Position voxels relative to world origin (camera-independent)
    const screenX = this.canvas.width / 2 + voxel.x * scale
    const screenY = this.canvas.height / 2 - voxel.y * scale
    // Use scale * 1.1 to ensure no gaps between voxels (slight overlap)
    const size = Math.max(1, scale * 1.1)

    // Track z position within layer for sorting
    const zInLayer = voxel.z

    return { x: screenX, y: screenY, size, zInLayer }
  }

  private renderLayerToCanvas(layer: Layer, cameraForRendering: Camera) {
    const ctx = layer.canvas.getContext('2d')
    if (!ctx) return 0
    ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height)

    // Layer depth and size are now in ABSOLUTE world coordinates
    const absoluteMinZ = layer.depth
    const absoluteMaxZ = layer.depth + layer.size
    layer.voxels = this.world.getVoxelsInAbsoluteZRange(absoluteMinZ, absoluteMaxZ)

    // Calculate viewing distance from camera to layer center
    // This determines the scale - farther layers appear smaller
    const layerCenterZ = layer.depth + layer.size / 2
    const viewingDistance = layerCenterZ - cameraForRendering.z
    
    // Skip layers behind the camera
    if (viewingDistance <= 0.1) {
      layer.dirty = false
      return 0
    }
    
    // Use viewing distance for scale calculation
    const scale = this.getProjectionScale(viewingDistance)
    
    const projected = layer.voxels
      .map(voxel => {
        // Position voxels relative to world origin (camera-independent)
        const screenX = this.canvas.width / 2 + voxel.x * scale
        const screenY = this.canvas.height / 2 - voxel.y * scale
        // Use scale * 1.1 to ensure no gaps between voxels (slight overlap)
        const size = Math.max(1, scale * 1.1)
        
        return { x: screenX, y: screenY, size, zInLayer: voxel.z, color: voxel.color }
      })
      .sort((a, b) => b.zInLayer - a.zInLayer)

    projected.forEach(p => {
      ctx.fillStyle = p.color
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size)
    })

    layer.dirty = false
    return projected.length
  }

  private getLayerBoundaries(): { depth: number; size: number }[] {
    // Use selectSlices to ensure contiguous z coverage without gaps
    const minZ = 1
    const maxZ = 200
    return selectSlices(this.camera.z, minZ, maxZ, this.depthMultiplier)
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
    
    this.updateLayers()
    
    this.ctx.fillStyle = '#0a0a15'
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)

    // Sort layers by depth (farther layers first, so closer layers render on top)
    const sortedLayers = Array.from(this.layers.values()).sort((a, b) => b.depth - a.depth)
    
    let layersRegenerated = 0
    let layersReused = 0
    let totalVoxels = 0

    sortedLayers.forEach(layer => {
      // Calculate viewing distance from current camera position
      const layerCenterZ = layer.depth + layer.size / 2
      const viewingDistance = layerCenterZ - this.camera.z
      
      // Skip layers behind the camera
      if (viewingDistance <= 0.1) {
        return
      }
      
      if (layer.dirty) {
        const voxelCount = this.renderLayerToCanvas(layer, this.camera)
        totalVoxels += voxelCount
        layersRegenerated++
      } else {
        layersReused++
      }

      if (layer.visible) {
        // Calculate parallax offset based on viewing distance
        // Closer layers (smaller viewing distance) move more with camera
        const scale = this.getProjectionScale(viewingDistance)
        
        // Offset is negative for X because moving camera right should shift view left
        // Offset is positive for Y because screen Y is inverted (positive Y = up in world, down in screen)
        const offsetX = -this.camera.x * scale
        const offsetY = this.camera.y * scale

        this.ctx.drawImage(layer.canvas, offsetX, offsetY)
        
        // Add a semi-transparent fog layer after each voxel layer
        // The fog intensity increases with viewing distance to create depth perception
        const fogIntensity = Math.min(0.15, viewingDistance / 500)
        if (fogIntensity > 0.01) {
          this.ctx.fillStyle = `rgba(10, 10, 21, ${String(fogIntensity)})`
          this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
        }
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

  regenerateWorld(seed?: number, worldType?: WorldType) {
    this.world = new World(seed, worldType)
    this.invalidateCacheWithMiss()
  }

  getWorldType(): WorldType {
    return this.world.worldType
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

  getDepthMultiplier(): number {
    return this.depthMultiplier
  }

  setDepthMultiplier(multiplier: number) {
    if (multiplier >= 1.2 && multiplier <= 4) {
      this.depthMultiplier = multiplier
      // Clear all layers to force regeneration with new slice boundaries
      this.layers.clear()
      this.invalidateCacheWithMiss()
    }
  }
}
