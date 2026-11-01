import { describe, it, expect } from 'vitest'
import { ParallaxRenderer, type Frame } from './renderer'
import { screenBox, screenRay } from './view'
import { World } from './world'

const world = new World(12345, 'hills_with_trees')
const [WIDTH, HEIGHT, STEP] = [800, 600, 3]

/**
 * The frame's colour at every STEP-th pixel, as the compositor draws it
 * (nearest texel, nearer layers first, pixels within a face's pyramid).
 */
function picture(frame: Frame): Uint32Array {
  const cols = Math.ceil(WIDTH / STEP)
  const colour = new Uint32Array(cols * Math.ceil(HEIGHT / STEP))
  const depth = new Float64Array(colour.length).fill(Infinity)
  frame.layers.forEach(({ face, distance, placements }, index) => {
    const boxOf = screenBox(frame, face)
    for (const { chunk, x, y } of placements) {
      const box = boxOf(x, x + chunk.width / chunk.scale, y - chunk.height / chunk.scale, y, distance)
      if (!box) continue
      for (let j = Math.max(0, Math.floor(box.minY / STEP)); j * STEP < Math.min(HEIGHT, box.maxY); j++) {
        for (let i = Math.max(0, Math.floor(box.minX / STEP)); i * STEP < Math.min(WIDTH, box.maxX); i++) {
          const k = j * cols + i
          if (depth[k] < index) continue
          const ray = screenRay(frame, face, i * STEP + 0.5, j * STEP + 0.5)
          if (Math.abs(ray.x) > ray.z || Math.abs(ray.y) > ray.z) continue
          const px = Math.floor(((ray.x / ray.z) * distance - x) * chunk.scale)
          const py = Math.floor((y - (ray.y / ray.z) * distance) * chunk.scale)
          if (px < 0 || py < 0 || px >= chunk.width || py >= chunk.height) continue
          const texel = chunk.pixels[py * chunk.width + px]
          if (texel === 0) continue
          depth[k] = index
          colour[k] = texel
        }
      }
    }
  })
  return colour
}

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
    expect(picture(frames[1].frame)).toEqual(picture(frames[0].frame))
  })
})
