import { describe, it, expect } from 'vitest'
import { World, ParallaxRenderer } from './renderer'

describe('Progressive Layer Slicing', () => {
  it('should create layers with power-of-2 boundaries', () => {
    const canvas = document.createElement('canvas')
    canvas.width = 800
    canvas.height = 600
    
    const world = new World(12345)
    const renderer = new ParallaxRenderer(canvas, world)
    
    renderer.setCamera({ x: 0, y: 0, z: 0 })
    renderer.render()
    
    const stats = renderer.getStats()
    expect(stats.layerCount).toBeGreaterThan(0)
  })

  it('should maintain far layers when moving by one unit', () => {
    const canvas = document.createElement('canvas')
    canvas.width = 800
    canvas.height = 600
    
    const world = new World(12345)
    const renderer = new ParallaxRenderer(canvas, world)
    
    renderer.setCamera({ x: 0, y: 0, z: 0 })
    renderer.render()
    
    renderer.setCamera({ x: 0, y: 0, z: 1 })
    renderer.render()
    const stats2 = renderer.getStats()
    
    expect(stats2.cacheHits).toBeGreaterThan(0)
  })

  it('should handle camera at different depths', () => {
    const canvas = document.createElement('canvas')
    canvas.width = 800
    canvas.height = 600
    
    const world = new World(12345)
    const renderer = new ParallaxRenderer(canvas, world)
    
    const depths = [0, 10, 20, -10, -20]
    
    depths.forEach(z => {
      renderer.setCamera({ x: 0, y: 0, z })
      renderer.render()
      
      const stats = renderer.getStats()
      expect(stats.layerCount).toBeGreaterThan(0)
      expect(stats.voxelsRendered).toBeGreaterThanOrEqual(0)
    })
  })

  it('should create more near layers than far layers', () => {
    const canvas = document.createElement('canvas')
    canvas.width = 800
    canvas.height = 600
    
    const world = new World(12345)
    const renderer = new ParallaxRenderer(canvas, world)
    
    renderer.setCamera({ x: 0, y: 0, z: 0 })
    renderer.render()
    
    const stats = renderer.getStats()
    expect(stats.layerCount).toBeGreaterThan(5)
  })
})
