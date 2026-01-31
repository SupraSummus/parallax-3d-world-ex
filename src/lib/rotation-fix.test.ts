import { describe, it, expect } from 'vitest'
import { World, ParallaxRenderer } from './renderer'

describe('Rotation Fix Integration Test', () => {
  it('should invalidate cache when camera rotates (THE FIX)', () => {
    const canvas = document.createElement('canvas')
    canvas.width = 800
    canvas.height = 600
    
    const world = new World(12345)
    const renderer = new ParallaxRenderer(canvas, world)
    
    renderer.render()
    const initialStats = renderer.getStats()
    const initialMisses = initialStats.cacheMisses
    
    renderer.setCamera({ rotationY: Math.PI / 4 })
    renderer.render()
    
    const afterRotationStats = renderer.getStats()
    const afterMisses = afterRotationStats.cacheMisses
    
    expect(afterMisses).toBeGreaterThan(initialMisses)
  })

  it('should update view content after rotation', () => {
    const canvas = document.createElement('canvas')
    canvas.width = 800
    canvas.height = 600
    
    const world = new World(12345)
    const renderer = new ParallaxRenderer(canvas, world)
    
    renderer.setCamera({ x: 0, y: 10, z: 0, rotationY: 0, rotationX: 0 })
    renderer.render()
    const voxelsAtZeroRotation = renderer.getStats().voxelsRendered
    
    renderer.setCamera({ x: 0, y: 10, z: 0, rotationY: Math.PI, rotationX: 0 })
    renderer.render()
    const voxelsAtPiRotation = renderer.getStats().voxelsRendered
    
    expect(voxelsAtZeroRotation).toBeGreaterThan(0)
    expect(voxelsAtPiRotation).toBeGreaterThan(0)
  })

  it('should handle smooth rotation animation sequence', () => {
    const canvas = document.createElement('canvas')
    canvas.width = 800
    canvas.height = 600
    
    const world = new World(12345)
    const renderer = new ParallaxRenderer(canvas, world)
    
    const rotationSteps = 10
    let previousVoxelCount = 0
    let cacheInvalidations = 0
    
    for (let i = 0; i < rotationSteps; i++) {
      const rotation = (i / rotationSteps) * Math.PI * 2
      const previousMisses = renderer.getStats().cacheMisses
      
      renderer.setCamera({ rotationY: rotation })
      renderer.render()
      
      const stats = renderer.getStats()
      
      if (stats.cacheMisses > previousMisses) {
        cacheInvalidations++
      }
      
      expect(stats.fps).toBeGreaterThan(0)
      expect(stats.voxelsRendered).toBeGreaterThanOrEqual(0)
      
      previousVoxelCount = stats.voxelsRendered
    }
    
    expect(cacheInvalidations).toBeGreaterThan(0)
  })

  it('should handle combined movement and rotation', () => {
    const canvas = document.createElement('canvas')
    canvas.width = 800
    canvas.height = 600
    
    const world = new World(12345)
    const renderer = new ParallaxRenderer(canvas, world)
    
    renderer.render()
    const initialMisses = renderer.getStats().cacheMisses
    
    renderer.setCamera({ 
      x: 5, 
      y: 10, 
      z: -5,
      rotationY: Math.PI / 3,
      rotationX: Math.PI / 6
    })
    renderer.render()
    
    const finalMisses = renderer.getStats().cacheMisses
    expect(finalMisses).toBeGreaterThan(initialMisses)
  })

  it('should maintain performance during rotation', () => {
    const canvas = document.createElement('canvas')
    canvas.width = 800
    canvas.height = 600
    
    const world = new World(12345)
    const renderer = new ParallaxRenderer(canvas, world)
    
    const frameTimes: number[] = []
    
    for (let i = 0; i < 20; i++) {
      renderer.setCamera({ rotationY: (i / 20) * Math.PI })
      renderer.render()
      frameTimes.push(renderer.getStats().frameTime)
    }
    
    const avgFrameTime = frameTimes.reduce((a, b) => a + b) / frameTimes.length
    const maxFrameTime = Math.max(...frameTimes)
    
    expect(avgFrameTime).toBeLessThan(100)
    expect(maxFrameTime).toBeLessThan(200)
  })
})
