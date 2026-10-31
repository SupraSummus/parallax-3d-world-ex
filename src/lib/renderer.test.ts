import { describe, it, expect, beforeEach } from 'vitest'
import { ParallaxRenderer, DEFAULT_CAMERA } from './renderer'
import { World } from './world'
import { selectSlices } from './slice-selection'

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
    renderer = new ParallaxRenderer(container, new World(12345))
    renderer.resize(800, 600)
  })

  describe('camera', () => {
    it('starts at the default position', () => {
      expect(renderer.getCamera()).toEqual(DEFAULT_CAMERA)
    })

    it('merges partial updates', () => {
      renderer.setCamera({ x: 5 })
      expect(renderer.getCamera()).toEqual({ ...DEFAULT_CAMERA, x: 5 })
    })
  })

  describe('layers', () => {
    it('renders one layer per selected slice, near to far', () => {
      renderer.render()
      const camera = renderer.getCamera()
      const expected = selectSlices(camera.z, 1, 200)
      expect(renderer.getLayers().map(l => ({ depth: l.depth, size: l.size }))).toEqual(expected)
      expect(lastUpdate().layerCount).toBe(expected.length)
    })

    it('puts exactly the slice voxels in each layer', () => {
      renderer.render()
      const layers = renderer.getLayers()
      expect(layers.some(l => l.voxels.length > 0)).toBe(true)
      for (const layer of layers) {
        for (const v of layer.voxels) {
          expect(v.z).toBeGreaterThanOrEqual(layer.depth)
          expect(v.z).toBeLessThan(layer.depth + layer.size)
        }
      }
      expect(lastUpdate().voxelsRendered).toBe(layers.reduce((n, l) => n + l.voxels.length, 0))
    })

    it('attaches a canvas and a fog overlay per layer, nearer layers on top', () => {
      renderer.render()
      const layers = renderer.getLayers()
      expect(container.querySelectorAll('canvas')).toHaveLength(layers.length)
      expect(container.children).toHaveLength(layers.length * 2)
      const zIndices = layers.map(l => Number(l.canvas.style.zIndex))
      expect(zIndices).toEqual([...zIndices].sort((a, b) => b - a))
    })

    it('sizes layer canvases to the viewport', () => {
      renderer.resize(1024, 768)
      renderer.render()
      for (const layer of renderer.getLayers()) {
        expect([layer.canvas.width, layer.canvas.height]).toEqual([1024, 768])
      }
    })

    it('hides a layer when toggled', () => {
      renderer.render()
      const layer = renderer.getLayers()[3]
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
      return { tx: Number(m[1]), ty: Number(m[2]), scale: Number(m[3]) }
    }

    it('scales nearer layers up more than farther ones', () => {
      renderer.render()
      const scales = renderer.getLayers().map(l => transformOf(l.canvas).scale)
      expect(scales).toEqual([...scales].sort((a, b) => b - a))
    })

    it('moves nearer layers further on sideways camera movement (parallax)', () => {
      renderer.setCamera({ x: 0 })
      renderer.render()
      renderer.setCamera({ x: 3 })
      renderer.render()
      const shifts = renderer.getLayers().map(l => -transformOf(l.canvas).tx)
      expect(shifts.every(s => s > 0)).toBe(true)
      expect(shifts).toEqual([...shifts].sort((a, b) => b - a))
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
      ['resize', (r: ParallaxRenderer) => { r.resize(1024, 768) }],
      ['depth multiplier change', (r: ParallaxRenderer) => { r.setDepthMultiplier(3) }],
    ])('rebuilds every layer after %s', (_, change) => {
      renderer.render()
      change(renderer)
      renderer.render()
      expect(lastUpdate().layersReused).toBe(0)
      expect(lastUpdate().layersRegenerated).toBe(lastUpdate().layerCount)
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
