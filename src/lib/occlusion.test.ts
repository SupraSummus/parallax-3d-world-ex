import { describe, it, expect } from 'vitest'
import { ParallaxRenderer } from './renderer'
import { picture } from './picture.test-helper'
import { World } from './world'

const world = new World(12345, 'hills_with_trees')
const [WIDTH, HEIGHT] = [800, 600]

describe('skipping covered chunks', () => {
  it.each([[0, 0], [20, -25], [-30, 10]])('leaves the picture unchanged (yaw %s°, pitch %s°)', (yaw, pitch) => {
    const frames = [false, true].map(skip => {
      const renderer = new ParallaxRenderer(world)
      renderer.resize(WIDTH, HEIGHT)
      renderer.setOrientation({ yaw, pitch })
      renderer.setSkipCovered(skip)
      renderer.render()
      return { frame: renderer.render(), covered: renderer.getStats().lastUpdate?.chunksCovered ?? 0 }
    })
    expect(frames[1].covered).toBeGreaterThan(0)
    expect(picture(frames[1].frame, 3)).toEqual(picture(frames[0].frame, 3))
  })
})
