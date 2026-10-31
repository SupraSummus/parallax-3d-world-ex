import { describe, it, expect, beforeEach } from 'vitest'
import {
  ParallaxRenderer, DEFAULT_FOV, MAX_FOV, MIN_FOV,
  DEFAULT_RENDER_DISTANCE, MAX_RENDER_DISTANCE, MIN_RENDER_DISTANCE,
  DEFAULT_MAX_LEAK, MAX_MAX_LEAK, MIN_MAX_LEAK,
} from './renderer'
import { World } from './world'
import { selectSlices, leakFreeDetail } from './slice-selection'

// Generating the forest takes a while; the renderer never modifies its world.
const world = new World(12345)

describe('ParallaxRenderer', () => {
  let container: HTMLDivElement
  let renderer: ParallaxRenderer

  const lastUpdate = () => {
    const update = renderer.getStats().lastUpdate
    if (!update) throw new Error('render() has not been called')
    return update
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

    it('puts exactly the slice voxels in each layer and draws one face per (x, y)', () => {
      renderer.render()
      const layers = renderer.getLayers()
      expect(layers.some(l => l.voxels.length > 0)).toBe(true)
      for (const layer of layers) {
        const inSlice = layer.voxels.every(v => v.z >= layer.depth && v.z < layer.depth + layer.size)
        expect(inSlice).toBe(true)
        expect(layer.facesDrawn).toBe(new Set(layer.voxels.map(v => `${String(v.x)},${String(v.y)}`)).size)
      }
      expect(lastUpdate().voxelsRendered).toBe(layers.reduce((n, l) => n + l.facesDrawn, 0))
    })

    it('attaches a canvas and a fog overlay per layer, nearer layers on top', () => {
      renderer.render()
      const layers = renderer.getLayers()
      expect(container.querySelectorAll('canvas')).toHaveLength(layers.length)
      expect(container.children).toHaveLength(layers.length * 2)
      const zIndices = layers.map(l => Number(l.canvas.style.zIndex))
      expect(zIndices).toEqual([...zIndices].sort((a, b) => b - a))
    })

    it('crops layer canvases to the slice content', () => {
      renderer.render()
      for (const layer of renderer.getLayers()) {
        if (layer.voxels.length === 0) {
          expect([layer.canvas.width, layer.canvas.height]).toEqual([0, 0])
          continue
        }
        const xs = layer.voxels.map(v => v.x)
        const ys = layer.voxels.map(v => v.y)
        expect(layer.canvas.width).toBe((Math.max(...xs) - Math.min(...xs) + 1) * 10)
        expect(layer.canvas.height).toBe((Math.max(...ys) - Math.min(...ys) + 1) * 10)
        expect(layer.originX).toBe(Math.min(...xs) - 0.5)
        expect(layer.originY).toBe(Math.max(...ys) + 0.5)
      }
    })

    it('hides a layer when toggled', () => {
      renderer.render()
      const layer = renderer.getLayers().filter(l => l.facesDrawn > 0)[1]
      renderer.toggleLayerVisibility(layer.depth)
      renderer.render()
      expect(layer.visible).toBe(false)
      expect(layer.canvas.style.display).toBe('none')
      renderer.toggleLayerVisibility(layer.depth)
      renderer.render()
      expect(layer.canvas.style.display).toBe('')
    })
  })

  describe('compositing', () => {
    const transformOf = (canvas: HTMLCanvasElement) => {
      const m = /translate3d\(([-\d.e]+)px, ([-\d.e]+)px, 0\) scale\(([-\d.e]+)\)/.exec(canvas.style.transform)
      if (!m) throw new Error(`unexpected transform: ${canvas.style.transform}`)
      return { left: Number(m[1]), top: Number(m[2]), scale: Number(m[3]) }
    }
    const drawnLayers = () => renderer.getLayers().filter(l => l.facesDrawn > 0)

    /** Screen position of world point (x, y) on a layer, per its CSS transform (origin 0 0). */
    const project = (layer: ReturnType<typeof drawnLayers>[number], x: number, y: number) => {
      const { left, top, scale } = transformOf(layer.canvas)
      return {
        sx: left + (x - layer.originX) * 10 * scale,
        sy: top + (layer.originY - y) * 10 * scale,
      }
    }

    beforeEach(() => {
      renderer.setCamera({ x: 0, y: 15, z: -30 })
    })

    it('scales nearer layers up more than farther ones', () => {
      renderer.render()
      const scales = drawnLayers().map(l => transformOf(l.canvas).scale)
      expect(scales.length).toBeGreaterThan(3)
      expect(scales).toEqual([...scales].sort((a, b) => b - a))
    })

    it('projects the point in front of the camera to the viewport centre on every layer', () => {
      renderer.render()
      for (const layer of drawnLayers()) {
        const { sx, sy } = project(layer, 0, 15)
        expect(sx).toBeCloseTo(400)
        expect(sy).toBeCloseTo(300)
      }
    })

    it('moves nearer layers further on sideways camera movement (parallax)', () => {
      renderer.render()
      const before = drawnLayers().map(l => project(l, 0, 0).sx)
      renderer.setCamera({ x: 3 })
      renderer.render()
      const shifts = drawnLayers().map((l, i) => before[i] - project(l, 0, 0).sx)
      expect(shifts.every(s => s > 0)).toBe(true)
      expect(shifts).toEqual([...shifts].sort((a, b) => b - a))
    })

    it.each([90, 45])('puts the longer viewport side at the edge of a %s° field of view', fov => {
      renderer.setFov(fov)
      renderer.render()
      const camera = renderer.getCamera()
      for (const layer of drawnLayers()) {
        const distance = layer.depth + layer.size / 2 - camera.z
        const focalLength = transformOf(layer.canvas).scale * 10 * distance
        expect(focalLength).toBeCloseTo(400 / Math.tan((fov * Math.PI) / 360))
      }
    })

    it('keeps world points at their projected position across a resize', () => {
      renderer.render()
      // Same longer side, so the same detail and slices.
      renderer.resize(600, 800)
      renderer.render()
      expect(lastUpdate().layersRegenerated).toBe(0)
      for (const layer of drawnLayers()) {
        const { sx, sy } = project(layer, 0, 15)
        expect(sx).toBeCloseTo(300)
        expect(sy).toBeCloseTo(400)
      }
    })

    it('hides empty slices and fogs farther slices more', () => {
      renderer.setCamera({ z: -70 })
      renderer.render()
      const layers = renderer.getLayers()
      const empty = layers.filter(l => l.facesDrawn === 0)
      expect(empty.length).toBeGreaterThan(0)
      for (const l of empty) expect(l.canvas.style.display).toBe('none')

      // Each fog overlay sits directly above its canvas; accumulated fog
      // transmittance over a slice must decrease with distance.
      const fogAlphas = layers.map(l => {
        const fog = l.canvas.nextElementSibling as HTMLElement
        return Number(/rgba\([^)]*, ([\d.]+)\)/.exec(fog.style.backgroundColor)?.[1])
      })
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
    it('reuses every layer when the camera only moves in x/y', () => {
      renderer.render()
      const canvases = renderer.getLayers().map(l => l.canvas)
      renderer.setCamera({ x: 7, y: 3 })
      renderer.render()
      expect(lastUpdate().layersRegenerated).toBe(0)
      expect(lastUpdate().cacheEfficiency).toBe(100)
      expect(renderer.getLayers().map(l => l.canvas)).toEqual(canvases)
    })

    it('reuses every layer when rendering the same camera twice', () => {
      renderer.render()
      renderer.render()
      expect(lastUpdate().layersRegenerated).toBe(0)
      expect(lastUpdate().voxelsRendered).toBe(0)
    })

    it.each([
      ['world regeneration', (r: ParallaxRenderer) => { r.regenerateWorld(99999) }],
    ])('rebuilds every layer after %s', (_, change) => {
      renderer.render()
      change(renderer)
      renderer.render()
      expect(lastUpdate().layersReused).toBe(0)
      expect(lastUpdate().layersRegenerated).toBe(lastUpdate().layerCount)
    })
  })

  describe('field of view', () => {
    it('clamps the field of view', () => {
      expect(renderer.getFov()).toBe(DEFAULT_FOV)
      renderer.setFov(1)
      expect(renderer.getFov()).toBe(MIN_FOV)
      renderer.setFov(500)
      expect(renderer.getFov()).toBe(MAX_FOV)
    })

    it('only zooms: the slicing does not depend on it', () => {
      renderer.render()
      const slices = renderer.getLayers()
      renderer.setFov(20)
      renderer.render()
      expect(lastUpdate().layersRegenerated).toBe(0)
      expect(renderer.getLayers()).toEqual(slices)
    })
  })

  describe('leak tolerance', () => {
    it('derives detail from the tolerance and the longer viewport side', () => {
      expect(renderer.getMaxLeak()).toBe(DEFAULT_MAX_LEAK)
      for (const pixels of [1, 4, 32]) {
        renderer.setMaxLeak(pixels)
        expect(renderer.getDetail()).toBe(leakFreeDetail(800, pixels))
      }
    })

    it('clamps the tolerance', () => {
      renderer.setMaxLeak(0)
      expect(renderer.getMaxLeak()).toBe(MIN_MAX_LEAK)
      renderer.setMaxLeak(1000)
      expect(renderer.getMaxLeak()).toBe(MAX_MAX_LEAK)
    })

    it('uses fewer, thicker slices for a larger tolerance', () => {
      renderer.setMaxLeak(1)
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

    it('clamps the render distance', () => {
      expect(renderer.getRenderDistance()).toBe(DEFAULT_RENDER_DISTANCE)
      renderer.setRenderDistance(1)
      expect(renderer.getRenderDistance()).toBe(MIN_RENDER_DISTANCE)
      renderer.setRenderDistance(1e6)
      expect(renderer.getRenderDistance()).toBe(MAX_RENDER_DISTANCE)
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
      expect(stats.totalLayersRegenerated).toBe(first.layersRegenerated + second.layersRegenerated)
      expect(stats.totalVoxelsRendered).toBe(first.voxelsRendered + second.voxelsRendered)
      expect(stats.totalRenderTime).toBeCloseTo(first.renderTime + second.renderTime)
      expect(stats.averageCacheEfficiency).toBeCloseTo((first.cacheEfficiency + second.cacheEfficiency) / 2)
    })
  })
})
