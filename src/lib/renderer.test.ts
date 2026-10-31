import { describe, it, expect, beforeEach } from 'vitest'
import { ParallaxRenderer, DEFAULT_RENDER_DISTANCE, type Chunk } from './renderer'
import { World } from './world'
import { selectSlices, leakFreeDetail, chunkWidth, directionStep } from './slice-selection'

// A small world with trees: rasterising the forest (~700k voxels) in jsdom
// takes seconds per test. The renderer never modifies its world.
const world = new World(12345, 'hills_with_trees')

describe('ParallaxRenderer', () => {
  let container: HTMLDivElement
  let renderer: ParallaxRenderer

  const lastUpdate = () => {
    const update = renderer.getStats().lastUpdate
    if (!update) throw new Error('render() has not been called')
    return update
  }

  const allChunks = () => renderer.getLayers().flatMap(l => l.chunks)
  const transformOf = (canvas: HTMLCanvasElement) => {
    const m = /translate3d\(([-\d.e]+)px, ([-\d.e]+)px, 0\) scale\(([-\d.e]+)\)/.exec(canvas.style.transform)
    if (!m) throw new Error(`unexpected transform: ${canvas.style.transform}`)
    return { left: Number(m[1]), top: Number(m[2]), scale: Number(m[3]) }
  }

  beforeEach(() => {
    container = document.createElement('div')
    renderer = new ParallaxRenderer(container, world)
    renderer.resize(800, 600)
  })

  describe('camera', () => {
    it("starts at the world's spawn point", () => {
      expect(renderer.getCamera()).toEqual(world.spawn)
    })

    it('merges partial updates', () => {
      renderer.setCamera({ x: 5 })
      expect(renderer.getCamera()).toEqual({ ...world.spawn, x: 5 })
    })

    it("moves to the new world's spawn point when the world is regenerated", () => {
      renderer.setCamera({ x: 5 })
      renderer.regenerateWorld(99999, 'hills')
      expect(renderer.getCamera()).toEqual(new World(99999, 'hills').spawn)
    })
  })

  describe('layers', () => {
    it('renders one layer per selected slice, near to far', () => {
      renderer.render()
      const camera = renderer.getCamera()
      const expected = selectSlices(camera.z, 1, DEFAULT_RENDER_DISTANCE, renderer.getDetail())
      expect(renderer.getLayers().map(l => ({ depth: l.depth, size: l.size }))).toEqual(expected)
      expect(lastUpdate().layerCount).toBe(expected.length)
    })

    it('puts exactly the slice voxels in each layer', () => {
      renderer.render()
      const layers = renderer.getLayers()
      expect(layers.some(l => l.voxels.length > 0)).toBe(true)
      for (const layer of layers) {
        expect(layer.voxels.every(v => v.z >= layer.depth && v.z < layer.depth + layer.size)).toBe(true)
        expect(layer.voxels).toHaveLength(world.getVoxelsInZRange(layer.depth, layer.depth + layer.size).length)
      }
    })

    it('splits slices into aligned chunks, each clipped to its cell', () => {
      renderer.render()
      const chunks = allChunks()
      expect(chunks.length).toBeGreaterThan(10)
      for (const layer of renderer.getLayers()) {
        const w = chunkWidth(layer.size)
        for (const chunk of layer.chunks) {
          expect(Math.abs(chunk.x % w)).toBe(0)
          expect(Math.abs(chunk.y % w)).toBe(0)
          expect(chunk.facesDrawn).toBeGreaterThan(0)
          // Canvas sizes are rounded up to whole pixels.
          const slack = 1 / chunk.scale
          expect(chunk.originX).toBeGreaterThanOrEqual(chunk.x - 0.5)
          expect(chunk.originX + chunk.canvas.width / chunk.scale).toBeLessThanOrEqual(chunk.x + w - 0.5 + slack)
          expect(chunk.originY).toBeLessThanOrEqual(chunk.y + w - 0.5)
          expect(chunk.originY - chunk.canvas.height / chunk.scale).toBeGreaterThanOrEqual(chunk.y - 0.5 - slack)
        }
      }
      expect(lastUpdate().voxelsRendered).toBeGreaterThanOrEqual(chunks.reduce((n, c) => n + c.facesDrawn, 0))
    })

    it('bakes each chunk along the grid direction nearest to the ray through its centre', () => {
      renderer.render()
      const step = directionStep(renderer.getDetail())
      const camera = renderer.getCamera()
      let oblique = 0
      for (const layer of renderer.getLayers()) {
        const w = chunkWidth(layer.size)
        const distance = layer.depth + (layer.size - 1) / 2 - camera.z
        for (const chunk of layer.chunks) {
          const tanX = (chunk.x + w / 2 - 0.5 - camera.x) / distance
          const tanY = (chunk.y + w / 2 - 0.5 - camera.y) / distance
          expect(Math.abs(chunk.tanX - tanX)).toBeLessThanOrEqual(step / 2 + 1e-9)
          expect(Math.abs(chunk.tanY - tanY)).toBeLessThanOrEqual(step / 2 + 1e-9)
          expect(Number.isInteger(chunk.tanX / step) && Number.isInteger(chunk.tanY / step)).toBe(true)
          if (chunk.tanX !== 0 || chunk.tanY !== 0) oblique++
        }
      }
      expect(oblique).toBeGreaterThan(0)
    })

    it('rasterises fewer pixels for farther, thicker slices', () => {
      renderer.render()
      const scales = renderer.getLayers().filter(l => l.chunks.length > 0).map(l => l.chunks[0].scale)
      expect(scales).toEqual([...scales].sort((a, b) => b - a))
      expect(scales[0]).toBeGreaterThan(scales[scales.length - 1])
    })

    it('only rasterises chunks that are at least partly on screen', () => {
      renderer.render()
      const wide = lastUpdate()
      for (const chunk of allChunks()) {
        const { left, top, scale } = transformOf(chunk.canvas)
        expect(left).toBeLessThan(800)
        expect(top).toBeLessThan(600)
        expect(left + chunk.canvas.width * scale).toBeGreaterThan(0)
        expect(top + chunk.canvas.height * scale).toBeGreaterThan(0)
      }
      // A narrower view shows less of every slice.
      const narrow = new ParallaxRenderer(document.createElement('div'), world)
      narrow.resize(800, 600)
      narrow.setFov(20)
      narrow.render()
      const narrowUpdate = narrow.getStats().lastUpdate
      expect(narrowUpdate?.chunkCount).toBeLessThan(wide.chunkCount)
      expect(narrowUpdate?.cachedPixels).toBeLessThan(wide.cachedPixels)
    })

    it('attaches the chunks in view and a fog overlay per layer, nearer layers on top', () => {
      renderer.render()
      const layers = renderer.getLayers()
      expect(container.querySelectorAll('canvas')).toHaveLength(allChunks().length)
      expect(container.querySelectorAll('div')).toHaveLength(layers.length)
      const zIndices = layers.filter(l => l.chunks.length > 0).map(l => {
        const own = new Set(l.chunks.map(c => c.canvas.style.zIndex))
        expect(own.size).toBe(1)
        return Number(l.chunks[0].canvas.style.zIndex)
      })
      expect(zIndices).toEqual([...zIndices].sort((a, b) => b - a))
    })

    it('detaches a layer\'s chunks when toggled', () => {
      renderer.render()
      const layer = renderer.getLayers().filter(l => l.chunks.length > 0)[1]
      const canvases = layer.chunks.map(c => c.canvas)
      renderer.toggleLayerVisibility(layer.depth)
      renderer.render()
      expect(layer.visible).toBe(false)
      expect(canvases.every(c => c.parentNode === null)).toBe(true)
      renderer.toggleLayerVisibility(layer.depth)
      renderer.render()
      expect(canvases.every(c => c.parentNode === container)).toBe(true)
      expect(lastUpdate().chunksRegenerated).toBe(0)
    })
  })

  describe('compositing', () => {
    /** First chunk of every layer with chunks in view, near to far. */
    const firstChunks = () => renderer.getLayers().flatMap(l => l.chunks.slice(0, 1).map(chunk => ({ layer: l, chunk })))

    /** Screen position of world point (x, y) on a chunk, per its CSS transform (origin 0 0). */
    const project = (chunk: Chunk, x: number, y: number) => {
      const { left, top, scale } = transformOf(chunk.canvas)
      return {
        sx: left + (x - chunk.originX) * chunk.scale * scale,
        sy: top + (chunk.originY - y) * chunk.scale * scale,
      }
    }

    beforeEach(() => {
      renderer.setCamera({ x: 0, y: 15, z: -30 })
    })

    it('scales nearer layers up more than farther ones', () => {
      renderer.render()
      const pixelsPerUnit = firstChunks().map(({ chunk }) => transformOf(chunk.canvas).scale * chunk.scale)
      expect(pixelsPerUnit.length).toBeGreaterThan(3)
      expect(pixelsPerUnit).toEqual([...pixelsPerUnit].sort((a, b) => b - a))
    })

    it('projects the point in front of the camera to the viewport centre on every chunk', () => {
      renderer.render()
      for (const chunk of allChunks()) {
        const { sx, sy } = project(chunk, 0, 15)
        expect(sx).toBeCloseTo(400)
        expect(sy).toBeCloseTo(300)
      }
    })

    it('moves nearer layers further on sideways camera movement (parallax)', () => {
      renderer.render()
      const tracked = firstChunks().map(({ chunk }) => ({ chunk, before: project(chunk, 0, 0).sx }))
      renderer.setCamera({ x: 1 })
      renderer.render()
      const shifts = tracked.filter(t => t.chunk.canvas.parentNode === container).map(t => t.before - project(t.chunk, 0, 0).sx)
      expect(shifts.length).toBeGreaterThan(3)
      expect(shifts.every(s => s > 0)).toBe(true)
      expect(shifts).toEqual([...shifts].sort((a, b) => b - a))
    })

    it.each([90, 45])('puts the longer viewport side at the edge of a %s° field of view', fov => {
      renderer.setFov(fov)
      renderer.render()
      const camera = renderer.getCamera()
      for (const { layer, chunk } of firstChunks()) {
        const distance = layer.depth + (layer.size - 1) / 2 - camera.z
        const focalLength = transformOf(chunk.canvas).scale * chunk.scale * distance
        expect(focalLength).toBeCloseTo(400 / Math.tan((fov * Math.PI) / 360))
      }
    })

    it('keeps world points at their projected position across a resize', () => {
      renderer.render()
      const slices = renderer.getLayers().map(l => [l.depth, l.size])
      // Same longer side, so the same detail and slices.
      renderer.resize(600, 800)
      renderer.render()
      expect(renderer.getLayers().map(l => [l.depth, l.size])).toEqual(slices)
      for (const chunk of allChunks()) {
        const { sx, sy } = project(chunk, 0, 15)
        expect(sx).toBeCloseTo(300)
        expect(sy).toBeCloseTo(400)
      }
    })

    it('draws nothing for empty slices and fogs farther slices more', () => {
      renderer.setCamera({ z: -70 })
      renderer.render()
      const layers = renderer.getLayers()
      expect(layers.some(l => l.voxels.length === 0 && l.chunks.length === 0)).toBe(true)

      // One fog overlay per slice; accumulated fog transmittance over a slice
      // must decrease with distance.
      const fogAlphas = [...container.querySelectorAll('div')]
        .sort((a, b) => Number(b.style.zIndex) - Number(a.style.zIndex))
        .map(fog => Number(/rgba\([^)]*, ([\d.]+)\)/.exec(fog.style.backgroundColor)?.[1]))
      expect(fogAlphas).toHaveLength(layers.length)
      // Few, visible steps rather than one nearly transparent overlay per slice.
      const steps = fogAlphas.filter(a => a > 0)
      expect(steps.every(a => a >= 0.05)).toBe(true)
      expect(steps.length).toBeLessThan(layers.length / 2)
      let transmittance = 1
      const accumulated = fogAlphas.map(a => (transmittance *= 1 - a))
      expect(accumulated).toEqual([...accumulated].sort((a, b) => b - a))
      expect(accumulated[accumulated.length - 1]).toBeLessThan(0.5)
    })
  })

  describe('cache', () => {
    it('reuses the chunks still in view when the camera moves in x/y', () => {
      renderer.render()
      renderer.setCamera({ x: renderer.getCamera().x + 2, y: renderer.getCamera().y + 1 })
      renderer.render()
      expect(lastUpdate().chunksReused).toBeGreaterThan(lastUpdate().chunksRegenerated * 4)
    })

    it('rasterises nothing when the camera returns to where it was', () => {
      renderer.render()
      const start = renderer.getCamera()
      const canvases = allChunks().map(c => c.canvas)
      renderer.setCamera({ x: start.x + 10 })
      renderer.render()
      renderer.setCamera(start)
      renderer.render()
      expect(lastUpdate().chunksRegenerated).toBe(0)
      expect(allChunks().map(c => c.canvas)).toEqual(canvases)
    })

    it('rasterises nothing when rendering the same camera twice', () => {
      renderer.render()
      renderer.render()
      expect(lastUpdate().chunksRegenerated).toBe(0)
      expect(lastUpdate().voxelsRendered).toBe(0)
      expect(lastUpdate().cacheEfficiency).toBe(100)
    })

    it('rebuilds every chunk after world regeneration', () => {
      renderer.render()
      renderer.regenerateWorld(99999)
      renderer.render()
      expect(lastUpdate().chunksReused).toBe(0)
      expect(lastUpdate().chunksRegenerated).toBe(lastUpdate().chunkCount)
      expect(container.querySelectorAll('canvas')).toHaveLength(lastUpdate().chunkCount)
    })
  })

  describe('settings', () => {
    it('derives detail from the field of view, viewport and leak tolerance', () => {
      for (const [fov, pixels] of [[90, 16], [90, 4], [10, 16]]) {
        renderer.setFov(fov)
        renderer.setMaxLeak(pixels)
        const tan = Math.tan((fov * Math.PI) / 360)
        // The longer viewport side is 800 px.
        expect(renderer.getDetail()).toBe(leakFreeDetail(400 / tan, tan, pixels))
      }
    })

    it('uses fewer, thicker slices for a larger tolerance', () => {
      renderer.setMaxLeak(4)
      renderer.render()
      const strict = lastUpdate()
      renderer.setMaxLeak(64)
      renderer.render()
      expect(lastUpdate().detail).toBeLessThan(strict.detail)
      expect(lastUpdate().layerCount).toBeLessThan(strict.layerCount)
      expect(lastUpdate().layerCount).toBe(selectSlices(world.spawn.z, 1, 200, lastUpdate().detail).length)
    })
  })

  describe('render distance', () => {
    it('covers exactly the render distance', () => {
      renderer.setRenderDistance(50)
      renderer.render()
      const camera = renderer.getCamera()
      const layers = renderer.getLayers()
      expect(layers.map(l => ({ depth: l.depth, size: l.size })))
        .toEqual(selectSlices(camera.z, 1, 50, renderer.getDetail()))
      const last = layers[layers.length - 1]
      expect(last.depth + last.size).toBeGreaterThanOrEqual(camera.z + 50)
      expect(last.depth).toBeLessThan(camera.z + 50)
    })
  })

  describe('stats', () => {
    it('accumulates session totals', () => {
      renderer.render()
      const first = lastUpdate()
      renderer.setCamera({ z: -20 })
      renderer.render()
      const second = lastUpdate()

      const stats = renderer.getStats()
      expect(stats.totalUpdates).toBe(2)
      expect(stats.totalChunksRegenerated).toBe(first.chunksRegenerated + second.chunksRegenerated)
      expect(stats.totalVoxelsRendered).toBe(first.voxelsRendered + second.voxelsRendered)
      expect(stats.totalRenderTime).toBeCloseTo(first.renderTime + second.renderTime)
      expect(stats.averageCacheEfficiency).toBeCloseTo((first.cacheEfficiency + second.cacheEfficiency) / 2)
    })
  })
})
