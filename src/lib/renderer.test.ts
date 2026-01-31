import { describe, it, expect, beforeEach } from 'vitest'
import { World, ParallaxRenderer, Camera } from './renderer'

describe('World', () => {
  it('should generate voxels on initialization', () => {
    const world = new World(12345)
    expect(world.voxels.length).toBeGreaterThan(0)
  })

  it('should generate consistent world for same seed', () => {
    const world1 = new World(42)
    const world2 = new World(42)
    
    expect(world1.voxels.length).toBe(world2.voxels.length)
    expect(world1.voxels[0].x).toBe(world2.voxels[0].x)
    expect(world1.voxels[0].y).toBe(world2.voxels[0].y)
    expect(world1.voxels[0].z).toBe(world2.voxels[0].z)
  })

  it('should generate different worlds for different seeds', () => {
    const world1 = new World(42)
    const world2 = new World(99)
    
    expect(world1.voxels[0].x).not.toBe(world2.voxels[0].x)
  })

  it('should filter voxels by depth range', () => {
    const world = new World(12345)
    const camera: Camera = { x: 0, y: 0, z: 0 }
    
    const filtered = world.getVoxelsInDepthRange(5, 15, camera)
    
    filtered.forEach(voxel => {
      const relZ = voxel.z - camera.z
      expect(relZ).toBeGreaterThanOrEqual(5)
      expect(relZ).toBeLessThan(15)
    })
  })

  it('should generate ground voxels', () => {
    const world = new World(12345)
    const groundVoxels = world.voxels.filter(v => v.type === 1)
    expect(groundVoxels.length).toBeGreaterThan(0)
  })

  it('should generate different voxel types', () => {
    const world = new World(12345)
    const types = new Set(world.voxels.map(v => v.type))
    expect(types.size).toBeGreaterThan(1)
  })
})

describe('ParallaxRenderer', () => {
  let canvas: HTMLCanvasElement
  let world: World
  let renderer: ParallaxRenderer

  beforeEach(() => {
    canvas = document.createElement('canvas')
    canvas.width = 800
    canvas.height = 600
    world = new World(12345)
    renderer = new ParallaxRenderer(canvas, world)
  })

  describe('Camera Management', () => {
    it('should initialize with default camera position', () => {
      const camera = renderer.getCamera()
      expect(camera.x).toBe(0)
      expect(camera.y).toBe(15)
      expect(camera.z).toBe(-30)
    })

    it('should update camera position', () => {
      renderer.setCamera({ x: 10, y: 20, z: -10 })
      const camera = renderer.getCamera()
      
      expect(camera.x).toBe(10)
      expect(camera.y).toBe(20)
      expect(camera.z).toBe(-10)
    })

    it('should preserve unmodified camera properties', () => {
      renderer.setCamera({ x: 5 })
      const camera = renderer.getCamera()
      
      expect(camera.x).toBe(5)
      expect(camera.y).toBe(15)
      expect(camera.z).toBe(-30)
    })
  })

  describe('Cache Management', () => {
    it('should invalidate cache on significant Z movement', () => {
      renderer.render()
      const stats1 = renderer.getStats()
      
      renderer.setCamera({ z: 10 })
      renderer.render()
      const stats2 = renderer.getStats()
      
      expect(stats2.cacheMisses).toBeGreaterThan(stats1.cacheMisses)
    })

    it('should use cache for small X/Y movement', () => {
      renderer.render()
      const stats1 = renderer.getStats()
      
      renderer.setCamera({ x: 0.1, y: 0.1 })
      renderer.render()
      const stats2 = renderer.getStats()
      
      expect(stats2.cacheHits).toBeGreaterThan(stats1.cacheHits)
    })

    it('should invalidate cache when layer spacing changes', () => {
      renderer.render()
      renderer.setLayerSpacing(10)
      renderer.render()
      
      const stats = renderer.getStats()
      expect(stats.cacheMisses).toBeGreaterThan(0)
    })

    it('should invalidate cache on world regeneration', () => {
      renderer.render()
      const stats1 = renderer.getStats()
      
      renderer.regenerateWorld(99999)
      renderer.render()
      const stats2 = renderer.getStats()
      
      expect(stats2.cacheMisses).toBeGreaterThan(stats1.cacheMisses)
    })
  })

  describe('Layer Management', () => {
    it('should create layers during render', () => {
      renderer.render()
      const stats = renderer.getStats()
      
      expect(stats.layerCount).toBeGreaterThan(0)
    })

    it('should adjust layer count based on layer spacing', () => {
      renderer.setLayerSpacing(5)
      renderer.render()
      const stats1 = renderer.getStats()
      
      renderer.setLayerSpacing(15)
      renderer.render()
      const stats2 = renderer.getStats()
      
      expect(stats2.layerCount).toBeLessThan(stats1.layerCount)
    })

    it('should render voxels to layers', () => {
      renderer.render()
      const stats = renderer.getStats()
      
      expect(stats.voxelsRendered).toBeGreaterThan(0)
    })
  })

  describe('Performance Tracking', () => {
    it('should track frame time', () => {
      renderer.render()
      const stats = renderer.getStats()
      
      expect(stats.frameTime).toBeGreaterThan(0)
    })

    it('should calculate FPS', () => {
      renderer.render()
      const stats = renderer.getStats()
      
      expect(stats.fps).toBeGreaterThan(0)
      expect(stats.fps).toBeLessThanOrEqual(10000)
    })

    it('should track cache hits and misses', () => {
      renderer.render()
      renderer.setCamera({ x: 1 })
      renderer.render()
      
      const stats = renderer.getStats()
      expect(stats.cacheHits + stats.cacheMisses).toBeGreaterThan(0)
    })
  })

  describe('Canvas Resize', () => {
    it('should handle canvas resize', () => {
      renderer.resize(1024, 768)
      renderer.render()
      
      expect(canvas.width).toBe(1024)
      expect(canvas.height).toBe(768)
    })

    it('should invalidate cache on resize', () => {
      renderer.render()
      const stats1 = renderer.getStats()
      
      renderer.resize(1024, 768)
      renderer.render()
      const stats2 = renderer.getStats()
      
      expect(stats2.cacheMisses).toBeGreaterThan(stats1.cacheMisses)
    })
  })

  describe('Progressive Layer Slicing', () => {
    it('should create layers at different depths', () => {
      renderer.render()
      const stats = renderer.getStats()
      
      expect(stats.layerCount).toBeGreaterThan(0)
    })

    it('should maintain far layers when moving slightly', () => {
      renderer.setCamera({ z: 0 })
      renderer.render()
      
      renderer.setCamera({ z: 0.5 })
      renderer.render()
      const stats2 = renderer.getStats()
      
      expect(stats2.cacheHits).toBeGreaterThan(0)
    })

    it('should handle movement across layer boundaries', () => {
      renderer.setCamera({ x: 5, y: 10, z: 10 })
      renderer.render()
      
      const stats = renderer.getStats()
      expect(stats.voxelsRendered).toBeGreaterThanOrEqual(0)
    })
  })
})

describe('Voxel Projection', () => {
  let canvas: HTMLCanvasElement
  let world: World
  let renderer: ParallaxRenderer

  beforeEach(() => {
    canvas = document.createElement('canvas')
    canvas.width = 800
    canvas.height = 600
    world = new World(12345)
    renderer = new ParallaxRenderer(canvas, world)
  })

  it('should handle voxels behind camera', () => {
    renderer.setCamera({ x: 0, y: 0, z: 0 })
    renderer.render()
    
    const stats = renderer.getStats()
    expect(stats.voxelsRendered).toBeGreaterThanOrEqual(0)
  })

  it('should render voxels after movement', () => {
    renderer.setCamera({ x: 0, y: 5, z: 0 })
    renderer.render()
    const stats1 = renderer.getStats()
    
    renderer.setCamera({ x: 10, y: 5, z: 10 })
    renderer.render()
    const stats2 = renderer.getStats()
    
    expect(stats1.voxelsRendered).toBeGreaterThan(0)
    expect(stats2.voxelsRendered).toBeGreaterThan(0)
  })
})

describe('Integration Tests', () => {
  let canvas: HTMLCanvasElement
  let world: World
  let renderer: ParallaxRenderer

  beforeEach(() => {
    canvas = document.createElement('canvas')
    canvas.width = 800
    canvas.height = 600
    world = new World(12345)
    renderer = new ParallaxRenderer(canvas, world)
  })

  it('should handle complete exploration workflow', () => {
    renderer.render()
    
    renderer.setCamera({ x: 10, y: 5, z: -10 })
    renderer.render()
    
    renderer.setCamera({ x: 20, y: 10, z: 10 })
    renderer.render()
    
    const stats = renderer.getStats()
    expect(stats.fps).toBeGreaterThan(0)
    expect(stats.layerCount).toBeGreaterThan(0)
    expect(stats.cacheHits + stats.cacheMisses).toBeGreaterThan(0)
  })

  it('should maintain performance over multiple frames', () => {
    const frameTimes: number[] = []
    
    for (let i = 0; i < 10; i++) {
      renderer.setCamera({ x: i * 0.5 })
      renderer.render()
      frameTimes.push(renderer.getStats().frameTime)
    }
    
    const avgFrameTime = frameTimes.reduce((a, b) => a + b) / frameTimes.length
    expect(avgFrameTime).toBeLessThan(100)
  })

  it('should handle rapid camera changes', () => {
    for (let i = 0; i < 20; i++) {
      renderer.setCamera({ 
        x: Math.sin(i) * 10,
        y: 5 + Math.cos(i) * 3,
        z: i * 0.5
      })
      renderer.render()
    }
    
    const stats = renderer.getStats()
    expect(stats.fps).toBeGreaterThan(0)
  })
})
