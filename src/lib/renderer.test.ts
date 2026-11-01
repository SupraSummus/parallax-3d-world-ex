import { describe, it, expect, beforeEach } from 'vitest'
import { ParallaxRenderer, DEFAULT_RENDER_DISTANCE, type Chunk, type Frame } from './renderer'
import { World } from './world'
import { selectSlices, leakFreeDetail, chunkWidth, directionStep } from './slice-selection'
import { MAX_VIEW_TANGENT, projector } from './view'

// A small world with trees: rasterising the forest (~700k voxels) in jsdom
// takes seconds per test. The renderer never modifies its world.
const world = new World(12345, 'hills_with_trees')

describe('ParallaxRenderer', () => {
  let renderer: ParallaxRenderer
  let frame: Frame
  const render = () => { frame = renderer.render() }

  const lastUpdate = () => {
    const update = renderer.getStats().lastUpdate
    if (!update) throw new Error('render() has not been called')
    return update
  }

  const allChunks = () => renderer.getLayers().flatMap(l => l.chunks)
  const placed = () => frame.layers.flatMap(l => l.placements)
  const placementOf = (chunk: Chunk) => {
    const layer = frame.layers.find(l => l.placements.some(p => p.chunk === chunk))
    const placement = layer?.placements.find(p => p.chunk === chunk)
    if (!layer || !placement) throw new Error('chunk not in the last frame')
    return { ...placement, distance: layer.distance }
  }

  /** Screen position of world point (x, y) on a chunk, per its placement. */
  const screenOf = (chunk: Chunk, x: number, y: number) => {
    const { x: px, y: py, distance } = placementOf(chunk)
    const point = projector(frame)({ x: px + x - chunk.originX, y: py + y - chunk.originY, z: distance })
    if (!point) throw new Error('point behind the camera')
    return point
  }

  /** Screen bounding box of a chunk's projected corners. */
  const screenBox = (chunk: Chunk) => {
    const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([i, j]) =>
      screenOf(chunk, chunk.originX + (i * chunk.width) / chunk.scale, chunk.originY - (j * chunk.height) / chunk.scale))
    const xs = corners.map(c => c.x)
    const ys = corners.map(c => c.y)
    return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) }
  }

  beforeEach(() => {
    renderer = new ParallaxRenderer(world)
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
      render()
      const camera = renderer.getCamera()
      const expected = selectSlices(camera.z, 1, DEFAULT_RENDER_DISTANCE, renderer.getDetail())
      expect(renderer.getLayers().map(l => ({ depth: l.depth, size: l.size }))).toEqual(expected)
      expect(lastUpdate().layerCount).toBe(expected.length)
    })

    it('counts exactly the slice voxels in each layer', () => {
      render()
      const layers = renderer.getLayers()
      expect(layers.some(l => l.voxelCount > 0)).toBe(true)
      for (const layer of layers) {
        const inSlice = world.voxels.filter(v => v.z >= layer.depth && v.z < layer.depth + layer.size)
        expect(layer.voxelCount).toBe(inSlice.length)
      }
    })

    it('splits slices into aligned chunks, each clipped to its cell', () => {
      render()
      const chunks = allChunks()
      expect(chunks.length).toBeGreaterThan(10)
      for (const layer of renderer.getLayers()) {
        const w = chunkWidth(layer.size)
        for (const chunk of layer.chunks) {
          expect(Math.abs(chunk.x % w)).toBe(0)
          expect(Math.abs(chunk.y % w)).toBe(0)
          expect(chunk.facesDrawn).toBeGreaterThan(0)
          // Sizes are rounded up to whole pixels.
          const slack = 1 / chunk.scale
          expect(chunk.originX).toBeGreaterThanOrEqual(chunk.x - 0.5)
          expect(chunk.originX + chunk.width / chunk.scale).toBeLessThanOrEqual(chunk.x + w - 0.5 + slack)
          expect(chunk.originY).toBeLessThanOrEqual(chunk.y + w - 0.5)
          expect(chunk.originY - chunk.height / chunk.scale).toBeGreaterThanOrEqual(chunk.y - 0.5 - slack)
        }
      }
      expect(lastUpdate().voxelsRendered).toBeGreaterThanOrEqual(chunks.reduce((n, c) => n + c.facesDrawn, 0))
    })

    it('bakes each chunk along the grid direction nearest to the ray through its centre', () => {
      render()
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
      render()
      const scales = renderer.getLayers().filter(l => l.chunks.length > 0).map(l => l.chunks[0].scale)
      expect(scales).toEqual([...scales].sort((a, b) => b - a))
      expect(scales[0]).toBeGreaterThan(scales[scales.length - 1])
    })

    it.each([[0, 0], [10, -10]])('only rasterises chunks that are at least partly on screen (yaw %s°, pitch %s°)', (yaw, pitch) => {
      renderer.setOrientation({ yaw, pitch })
      render()
      const wide = lastUpdate()
      for (const { chunk } of placed()) {
        const box = screenBox(chunk)
        expect(box.left).toBeLessThan(800)
        expect(box.top).toBeLessThan(600)
        expect(box.right).toBeGreaterThan(0)
        expect(box.bottom).toBeGreaterThan(0)
      }
      // A narrower view shows less of every slice. (Not necessarily in fewer
      // chunks: its thinner slices have more, some holding only grown faces.)
      const narrow = new ParallaxRenderer(world)
      narrow.resize(800, 600)
      narrow.setFov(20)
      narrow.setOrientation({ yaw, pitch })
      narrow.render()
      expect(narrow.getStats().lastUpdate?.cachedPixels).toBeLessThan(wide.cachedPixels)
    })

    it('places the chunks in view layer by layer, near to far', () => {
      render()
      expect(frame.layers.map(l => l.placements.map(p => p.chunk))).toEqual(renderer.getLayers().map(l => l.chunks))
    })

    it('leaves out a hidden layer\'s chunks but keeps its fog', () => {
      render()
      const index = renderer.getLayers().findIndex(l => l.chunks.length > 0)
      const layer = renderer.getLayers()[index]
      const before = frame.layers[index]
      renderer.toggleLayerVisibility(layer.depth)
      render()
      expect(layer.visible).toBe(false)
      expect(frame.layers[index]).toEqual({ distance: before.distance, placements: [], fog: before.fog })
      renderer.toggleLayerVisibility(layer.depth)
      render()
      expect(frame.layers[index]).toEqual(before)
      expect(lastUpdate().chunksRegenerated).toBe(0)
    })
  })

  describe('compositing', () => {
    /** First chunk of every layer with chunks in view, near to far. */
    const firstChunks = () => renderer.getLayers().flatMap(l => l.chunks.slice(0, 1).map(chunk => ({ layer: l, chunk })))

    /** Screen pixels per world unit on a chunk's plane, at its top-left corner, looking straight ahead. */
    const pixelsPerUnit = (chunk: Chunk) => screenOf(chunk, chunk.originX + 1, chunk.originY).x - screenOf(chunk, chunk.originX, chunk.originY).x

    beforeEach(() => {
      renderer.setCamera({ x: 0, y: 15, z: -30 })
    })

    it('scales nearer layers up more than farther ones', () => {
      render()
      const scales = firstChunks().map(({ chunk }) => pixelsPerUnit(chunk))
      expect(scales.length).toBeGreaterThan(3)
      expect(scales).toEqual([...scales].sort((a, b) => b - a))
    })

    it.each([[0, 0], [10, -10]])('projects the point the camera looks at (yaw %s°, pitch %s°) to the viewport centre on every chunk', (yaw, pitch) => {
      renderer.setOrientation({ yaw, pitch })
      render()
      const [y, p] = [yaw, pitch].map(a => (a * Math.PI) / 180)
      for (const { distance, placements } of frame.layers) {
        // Where the view direction meets the layer's plane; the camera is at (0, 15).
        const ahead = { x: Math.tan(y) * distance, y: 15 + (Math.tan(p) / Math.cos(y)) * distance }
        for (const { chunk } of placements) {
          expect(screenOf(chunk, ahead.x, ahead.y)).toEqual({ x: expect.closeTo(400) as number, y: expect.closeTo(300) as number })
        }
      }
    })

    it('moves nearer layers further on sideways camera movement (parallax)', () => {
      render()
      const tracked = firstChunks().map(({ chunk }) => ({ chunk, before: screenOf(chunk, 0, 0).x }))
      renderer.setCamera({ x: 1 })
      render()
      const shifts = tracked.filter(t => placed().some(p => p.chunk === t.chunk)).map(t => t.before - screenOf(t.chunk, 0, 0).x)
      expect(shifts.length).toBeGreaterThan(3)
      expect(shifts.every(s => s > 0)).toBe(true)
      expect(shifts).toEqual([...shifts].sort((a, b) => b - a))
    })

    it.each([90, 45])('puts the longer viewport side at the edge of a %s° field of view', fov => {
      renderer.setFov(fov)
      render()
      const camera = renderer.getCamera()
      for (const { layer, chunk } of firstChunks()) {
        const distance = layer.depth + (layer.size - 1) / 2 - camera.z
        const focalLength = pixelsPerUnit(chunk) * distance
        expect(focalLength).toBeCloseTo(400 / Math.tan((fov * Math.PI) / 360))
      }
    })

    it('keeps world points at their projected position across a resize', () => {
      render()
      const slices = renderer.getLayers().map(l => [l.depth, l.size])
      // Same longer side, so the same detail and slices.
      renderer.resize(600, 800)
      render()
      expect(renderer.getLayers().map(l => [l.depth, l.size])).toEqual(slices)
      for (const chunk of allChunks()) {
        const { x, y } = screenOf(chunk, 0, 15)
        expect(x).toBeCloseTo(300)
        expect(y).toBeCloseTo(400)
      }
    })

    it('draws nothing for empty slices and fogs farther slices more', () => {
      renderer.setCamera({ z: -70 })
      render()
      const layers = renderer.getLayers()
      expect(layers.some(l => l.voxelCount === 0 && l.chunks.length === 0)).toBe(true)

      const fogs = frame.layers.map(l => l.fog)
      expect(fogs).toHaveLength(layers.length)
      expect(fogs[0]).toBeGreaterThan(0)
      expect(fogs).toEqual([...fogs].sort((a, b) => a - b))
      // The sky, behind every slice, is fogged most.
      expect(frame.fog).toBeGreaterThanOrEqual(fogs[fogs.length - 1])
      expect(frame.fog).toBeGreaterThan(0.5)
      expect(frame.fog).toBeLessThan(1)
    })
  })

  describe('cache', () => {
    it('reuses the chunks still in view when the camera moves in x/y', () => {
      render()
      renderer.setCamera({ x: renderer.getCamera().x + 2, y: renderer.getCamera().y + 1 })
      render()
      expect(lastUpdate().chunksReused).toBeGreaterThan(lastUpdate().chunksRegenerated * 4)
    })

    it('rasterises nothing when the camera returns to where it was', () => {
      render()
      const start = renderer.getCamera()
      const chunks = allChunks()
      renderer.setCamera({ x: start.x + 10 })
      render()
      renderer.setCamera(start)
      render()
      expect(lastUpdate().chunksRegenerated).toBe(0)
      expect(allChunks().every((c, i) => c === chunks[i])).toBe(true)
      expect(allChunks()).toHaveLength(chunks.length)
    })

    it('rasterises nothing when rendering the same camera twice', () => {
      render()
      render()
      expect(lastUpdate().chunksRegenerated).toBe(0)
      expect(lastUpdate().voxelsRendered).toBe(0)
      expect(lastUpdate().cacheEfficiency).toBe(100)
    })

    it('keeps the slices when turning, rasterising only chunks that come into view', () => {
      render()
      const slices = renderer.getLayers().map(l => [l.depth, l.size])
      const chunks = new Set(allChunks())
      renderer.setOrientation({ yaw: 10, pitch: 5 })
      render()
      expect(renderer.getLayers().map(l => [l.depth, l.size])).toEqual(slices)
      expect(lastUpdate().chunksReused).toBeGreaterThan(lastUpdate().chunksRegenerated)
      expect(allChunks().filter(c => !chunks.has(c))).toHaveLength(lastUpdate().chunksRegenerated)
      renderer.setOrientation({ yaw: 0, pitch: 0 })
      render()
      expect(lastUpdate().chunksRegenerated).toBe(0)
    })

    it('rebuilds every chunk after world regeneration', () => {
      render()
      renderer.regenerateWorld(99999, 'hills_with_trees')
      render()
      expect(lastUpdate().chunksReused).toBe(0)
      expect(lastUpdate().chunksRegenerated).toBe(lastUpdate().chunkCount)
      expect(placed()).toHaveLength(lastUpdate().chunkCount)
    })
  })

  describe('settings', () => {
    it('derives detail from the field of view, viewport and leak tolerance', () => {
      for (const [fov, pixels] of [[90, 16], [90, 4], [10, 16]]) {
        renderer.setFov(fov)
        renderer.setMaxLeak(pixels)
        const tan = Math.tan((fov * Math.PI) / 360)
        // The longer viewport side is 800 px; rays may be turned up to MAX_VIEW_TANGENT.
        expect(renderer.getDetail()).toBe(leakFreeDetail(400 / tan, MAX_VIEW_TANGENT, pixels))
      }
    })

    it('uses fewer, thicker slices for a larger tolerance', () => {
      renderer.setMaxLeak(4)
      render()
      const strict = lastUpdate()
      renderer.setMaxLeak(64)
      render()
      expect(lastUpdate().detail).toBeLessThan(strict.detail)
      expect(lastUpdate().layerCount).toBeLessThan(strict.layerCount)
      expect(lastUpdate().layerCount).toBe(selectSlices(world.spawn.z, 1, 200, lastUpdate().detail).length)
    })
  })

  describe('render distance', () => {
    it('covers exactly the render distance', () => {
      renderer.setRenderDistance(50)
      render()
      const camera = renderer.getCamera()
      const layers = renderer.getLayers()
      expect(layers.map(l => ({ depth: l.depth, size: l.size })))
        .toEqual(selectSlices(camera.z, 1, 50, renderer.getDetail()))
      const last = layers[layers.length - 1]
      expect(last.depth + last.size).toBeGreaterThanOrEqual(camera.z + 50)
      expect(last.depth).toBeLessThan(camera.z + 50)
    })
  })

  describe('orientation', () => {
    it('turns as far as the slices reach, and turns back when the view widens', () => {
      renderer.setOrientation({ yaw: 90 })
      const { yaw } = renderer.getOrientation()
      // 90° across 800 px puts the side edge at 45°; it may turn to atan(2).
      expect(yaw).toBeCloseTo((Math.atan(MAX_VIEW_TANGENT) * 180) / Math.PI - 45, 3)
      renderer.setFov(110)
      expect(renderer.getOrientation().yaw).toBeLessThan(yaw)
    })
  })

  describe('stats', () => {
    it('accumulates session totals', () => {
      render()
      const first = lastUpdate()
      renderer.setCamera({ z: -20 })
      render()
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
