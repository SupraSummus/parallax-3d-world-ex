import { describe, it, expect } from 'vitest'
import { ParallaxRenderer, type Frame } from './renderer'
import { World } from './world'
import { projector } from './view'

/**
 * Behavioral regression tests for previously fixed rendering bugs. They check
 * observable output only: the pixels of the chunks in a frame, where the
 * frame puts them, and the per-render stats.
 */

// A small world with trees: rasterising the forest (~700k voxels) in jsdom
// takes seconds per test. The renderer never modifies its world.
const world = new World(12345, 'hills_with_trees')

function makeWorldWithVoxels(voxels: World['voxels']): World {
  const custom = new World(1, 'hills') // cheapest world to generate; its voxels are replaced
  custom.voxels = voxels
  return custom
}

/** Screen positions (CSS pixels) of the centres of all drawn chunk pixels. */
function drawnPixels(frame: Frame): { x: number; y: number }[] {
  return frame.layers.flatMap(({ distance, placements }) => placements.flatMap(({ chunk, x, y }) => {
    const points: { x: number; y: number }[] = []
    chunk.pixels.forEach((pixel, i) => {
      if (pixel === 0) return
      const point = projector(frame)({
        x: x + ((i % chunk.width) + 0.5) / chunk.scale,
        y: y - (Math.floor(i / chunk.width) + 0.5) / chunk.scale,
        z: distance,
      })
      if (point) points.push(point)
    })
    return points
  }))
}

/**
 * Screen pixels in columns [fromX, toX) that nothing covers, between covered
 * ones, compositing an unturned view as the compositor does (nearest chunk pixel).
 */
function gapPixels(frame: Frame, fromX: number, toX: number): number {
  const { width, height, focal } = frame
  const covered = new Uint8Array(width * height)
  for (const { distance, placements } of frame.layers) {
    for (const { chunk, x, y } of placements) {
      const corner = projector(frame)({ x, y, z: distance })
      if (!corner) continue
      // Screen pixels per chunk pixel.
      const scale = focal / distance / chunk.scale
      const left = Math.max(0, Math.ceil(corner.x - 0.5))
      const right = Math.min(width, corner.x + chunk.width * scale - 0.5)
      for (let row = Math.max(0, Math.ceil(corner.y - 0.5)); row < Math.min(height, corner.y + chunk.height * scale - 0.5); row++) {
        const v = Math.floor((row + 0.5 - corner.y) / scale)
        for (let column = left; column < right; column++) {
          const u = Math.floor((column + 0.5 - corner.x) / scale)
          if (chunk.pixels[v * chunk.width + u] !== 0) covered[row * width + column] = 1
        }
      }
    }
  }
  let gaps = 0
  for (let x = fromX; x < toX; x++) {
    const column = Array.from({ length: height }, (_, y) => covered[y * width + x])
    gaps += column.slice(column.indexOf(1), column.lastIndexOf(1)).filter(c => c === 0).length
  }
  return gaps
}

describe('Renderer regressions', () => {
  // Near layers used to be rasterised at their full perspective scale, so a
  // voxel right in front of the camera landed far outside the canvas bitmap.
  // Layers are now rasterised at a fixed scale and scaled when compositing.
  it('shows voxels right in front of the camera inside the viewport', () => {
    // A column from the ground up to eye level, 1 unit ahead of the camera.
    const voxels: World['voxels'] = []
    for (let y = 0; y <= 15; y++) {
      voxels.push({ x: 0, y, z: -29, color: '#00ff00', type: 1 })
    }
    const renderer = new ParallaxRenderer(makeWorldWithVoxels(voxels))
    renderer.resize(800, 600)
    renderer.setCamera({ x: 0, y: 15, z: -30 })

    const visible = drawnPixels(renderer.render()).filter(p => p.x >= 0 && p.x < 800 && p.y >= 0 && p.y < 600)
    expect(visible.length).toBeGreaterThan(0)
  })

  // Small z moves used to invalidate every layer, including distant ones
  // whose content had not changed.
  describe('z-movement cache churn', () => {
    it('reuses most chunks after a 1-unit Z move from the initial camera position', () => {
      const renderer = new ParallaxRenderer(world)
      renderer.resize(800, 600)
      renderer.setCamera({ x: 0, y: 15, z: -30 })

      renderer.render() // initial: everything dirty, regenerated once
      renderer.setCamera({ x: 0, y: 15, z: -29 })
      renderer.render()

      const stats = renderer.getStats().lastUpdate
      expect(stats).toBeDefined()
      // Very near layers (size 1 at viewingDistance ~1) legitimately need to
      // redraw because their scale changes noticeably. Distant layers that
      // cover 64 z-units shouldn't. So "reused" should meaningfully beat
      // "regenerated".
      expect(stats?.chunksReused ?? 0).toBeGreaterThan(stats?.chunksRegenerated ?? 0)
    })

    it('does not re-render every chunk on every keypress when moving along Z', () => {
      const renderer = new ParallaxRenderer(world)
      renderer.resize(800, 600)
      renderer.setCamera({ x: 0, y: 15, z: -30 })

      renderer.render()
      const initialRegens = renderer.getStats().totalChunksRegenerated
      const chunkCount = renderer.getLayers().flatMap(l => l.chunks).length

      // Simulate holding W for 8 frames at the default move speed of 0.5.
      for (let i = 1; i <= 8; i++) {
        renderer.setCamera({ x: 0, y: 15, z: -30 + i * 0.5 })
        renderer.render()
      }

      const regensDuringMovement =
        renderer.getStats().totalChunksRegenerated - initialRegens

      // Only near slices that get re-tiled, plus newly entering ones, should
      // re-render: well under one full re-render per frame.
      expect(regensDuringMovement).toBeLessThan(chunkCount * 2)
    })
  })

  // Layers leaving the view used to be deleted, so moving forward and back
  // re-rendered them. They are now kept in an LRU cache.
  describe('layers leaving and re-entering view', () => {
    it('reuses chunks when the camera returns to an already-visited Z position', () => {
      const renderer = new ParallaxRenderer(world)
      renderer.resize(800, 600)
      renderer.setCamera({ x: 0, y: 15, z: -30 })

      renderer.render() // warm cache at z=-30

      // Take a round trip: forward a few units, then back to the exact start.
      renderer.setCamera({ x: 0, y: 15, z: -25 })
      renderer.render()
      renderer.setCamera({ x: 0, y: 15, z: -30 })
      renderer.render()

      const returnStats = renderer.getStats().lastUpdate
      expect(returnStats).toBeDefined()
      expect(returnStats?.chunksReused ?? 0).toBeGreaterThan(returnStats?.chunksRegenerated ?? 0)
    })
  })

  // Slices move what they show by up to the leak bound, so a thin floor
  // seen from high above showed the sky between them. Grown faces cover it.
  describe('one voxel thick floor seen from high above', () => {
    const voxels: World['voxels'] = []
    for (let x = -40; x < 40; x++) {
      for (let z = 0; z < 600; z++) voxels.push({ x, y: 0, z, color: '#40a040', type: 1 })
    }
    const floor = makeWorldWithVoxels(voxels)
    const gaps = (fillGaps: boolean) => {
      const renderer = new ParallaxRenderer(floor)
      renderer.resize(1280, 800)
      renderer.setRenderDistance(400)
      renderer.setCamera({ x: 0.3, y: 100, z: -2 })
      renderer.setFillGaps(fillGaps)
      // Columns well inside the floor: grown faces may stick out past its sides.
      return gapPixels(renderer.render(), 540, 740)
    }

    it('shows the sky between slices without filling gaps', () => {
      expect(gaps(false)).toBeGreaterThan(0)
    })

    it('has no gaps with filling', () => {
      expect(gaps(true)).toBe(0)
    })
  })
})
