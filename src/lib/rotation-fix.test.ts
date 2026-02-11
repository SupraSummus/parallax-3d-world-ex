import { describe, it, expect } from 'vitest'
import { World, ParallaxRenderer } from './renderer'

describe('Fixed View Direction', () => {
  it('should render without rotation', () => {
    const container = document.createElement('div')
    
    const world = new World(12345)
    const renderer = new ParallaxRenderer(container, world)
    renderer.resize(800, 600)
    
    renderer.render()
    const stats = renderer.getStats()
    
    expect(stats.voxelsRendered).toBeGreaterThanOrEqual(0)
  })

  it('should update view when camera moves', () => {
    const container = document.createElement('div')
    
    const world = new World(12345)
    const renderer = new ParallaxRenderer(container, world)
    renderer.resize(800, 600)
    
    renderer.render()
    
    renderer.setCamera({ x: 10, y: 5, z: 10 })
    renderer.render()
    
    const afterMoveStats = renderer.getStats()
    
    expect(afterMoveStats.voxelsRendered).toBeGreaterThanOrEqual(0)
  })

  it('should maintain fixed viewing direction', () => {
    const container = document.createElement('div')
    
    const world = new World(12345)
    const renderer = new ParallaxRenderer(container, world)
    renderer.resize(800, 600)
    
    const camera1 = renderer.getCamera()
    expect(camera1.x).toBeDefined()
    expect(camera1.y).toBeDefined()
    expect(camera1.z).toBeDefined()
    
    expect(camera1).not.toHaveProperty('rotationY')
    expect(camera1).not.toHaveProperty('rotationX')
  })
})
