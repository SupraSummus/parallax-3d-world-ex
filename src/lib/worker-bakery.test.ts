import { describe, it, expect } from 'vitest'
import { bakeHandler, ChunkBaker, type BakeMessage, type BakeResult, type ChunkRequest } from './chunk-baker'
import { ParallaxRenderer, type Bakery, type Camera, type Frame } from './renderer'
import type { Orientation } from './view'
import { picture } from './picture.test-helper'
import { VoxelGrid } from './voxel-grid'
import { WorkerBakery, type BakeWorker } from './worker-bakery'
import { World } from './world'

// A small world with trees, as in renderer.test.ts.
const world = new World(12345, 'hills_with_trees')

/** bake.worker.ts in microtasks: asynchronous and in order, like a worker, and done before the next timer. */
class FakeWorker implements BakeWorker {
  onmessage: ((event: MessageEvent<BakeResult>) => void) | null = null
  bakes = 0
  private handle = bakeHandler(result => {
    queueMicrotask(() => { this.onmessage?.({ data: result } as MessageEvent<BakeResult>) })
  })

  postMessage(message: BakeMessage) {
    if (message.type === 'bake') this.bakes++
    queueMicrotask(() => { this.handle(message) })
  }

  terminate() {}
}

const tick = () => new Promise(resolve => setTimeout(resolve))

function workerRenderer(workers = [new FakeWorker(), new FakeWorker()]) {
  const renderer = new ParallaxRenderer(world, { bakery: new WorkerBakery(workers) })
  renderer.resize(800, 600)
  return renderer
}

/** Remembers the chunks wanted: all of them, and the latest list. */
class RecordingBakery extends WorkerBakery {
  all: ChunkRequest[] = []
  latest: ChunkRequest[] = []
  override want(requests: ChunkRequest[]) {
    this.all.push(...requests)
    this.latest = requests
    super.want(requests)
  }
}

/** A chunk's cell: its face, slice and position. */
const cell = ({ face, depth, size, i, j }: ChunkRequest) => [face, depth, size, i, j].join()

const pending = (renderer: ParallaxRenderer) => renderer.getStats().lastUpdate?.chunksPending ?? 0

/** Renders until no chunk in view is still baking. */
async function settle(renderer: ParallaxRenderer): Promise<Frame> {
  for (;;) {
    const frame = renderer.render()
    if (pending(renderer) === 0) return frame
    await tick()
  }
}

/** FNV-1a: comparing (and diffing) the pixel arrays themselves is slow. */
function checksum(pixels: Uint32Array): number {
  let hash = 0x811c9dc5
  for (const pixel of pixels) hash = Math.imul(hash ^ pixel, 0x01000193)
  return hash >>> 0
}

/** Each layer's chunks: content and where they go. */
const shown = (frame: Frame) => frame.layers.map(l => l.placements.map(({ chunk, x, y }) =>
  ({ i: chunk.i, j: chunk.j, tanX: chunk.tanX, tanY: chunk.tanY, pixels: checksum(chunk.pixels), x, y })))

/** What baking on the main thread shows. */
function reference(camera?: Camera, from = world, orientation?: Orientation) {
  const renderer = new ParallaxRenderer(from)
  renderer.resize(800, 600)
  if (camera) renderer.setCamera(camera)
  if (orientation) renderer.setOrientation(orientation)
  return shown(renderer.render())
}

describe('WorkerBakery', () => {
  it.each([[0, 0], [135, 30]])('ends up showing what baking on the main thread shows (yaw %s°, pitch %s°)', async (yaw, pitch) => {
    // In the middle of the world, so there is something in every direction.
    const camera = { x: 0, y: 15, z: 0 }
    const renderer = workerRenderer()
    renderer.setCamera(camera)
    renderer.setOrientation({ yaw, pitch })
    expect(shown(renderer.render()).flat()).toEqual([])
    expect(shown(await settle(renderer))).toEqual(reference(camera, world, { yaw, pitch }))
    const faces = new Set(renderer.getLayers().filter(l => l.chunks.length > 0).map(l => l.face))
    // Straight along +z, four faces meet in the middle of the screen.
    expect(faces.size).toBeGreaterThanOrEqual(yaw === 0 ? 4 : 3)
  })

  it("shows a cell's older bake while its new direction is baking", async () => {
    const renderer = workerRenderer()
    await settle(renderer)
    // Far enough sideways that the nearest slices' directions change.
    renderer.setCamera({ x: renderer.getCamera().x + 3 })
    const baking = shown(renderer.render())
    const target = reference(renderer.getCamera())
    const standIns = baking.flatMap((layer, i) => layer.filter(c =>
      target[i].some(t => t.i === c.i && t.j === c.j && (t.tanX !== c.tanX || t.tanY !== c.tanY))))
    expect(standIns.length).toBeGreaterThan(0)
    expect(shown(await settle(renderer))).toEqual(target)
  })

  it('bakes only the chunks of the latest render, besides those already in flight', async () => {
    const workers = [new FakeWorker(), new FakeWorker()]
    const renderer = workerRenderer(workers)
    renderer.render()
    const leftBehind = pending(renderer)
    renderer.setCamera({ x: 500 })
    renderer.render()
    const needed = pending(renderer)
    await settle(renderer)
    const wasted = workers[0].bakes + workers[1].bakes - needed
    // At most what was in flight, out of ~1700.
    expect(wasted).toBeLessThan(leftBehind / 20)
  })

  it('bakes cells that show nothing before rebaking cells an older bake stands in for', async () => {
    const bakery = new RecordingBakery([new FakeWorker(), new FakeWorker()])
    const renderer = new ParallaxRenderer(world, { bakery })
    renderer.resize(800, 600)
    // Covered cells are not baked: bake every cell, so each has an older bake.
    renderer.setSkipCovered(false)
    await settle(renderer)
    const baked = new Set(bakery.all.map(cell))
    // Forward and sideways: near slices re-tile, and the other chunks change direction.
    const { x, z } = renderer.getCamera()
    renderer.setCamera({ x: x + 3, z: z + 3 })
    renderer.render()
    const standsIn = bakery.latest.map(r => baked.has(cell(r)))
    expect(standsIn.indexOf(false)).toBe(0)
    expect(standsIn.lastIndexOf(false)).toBeLessThan(standsIn.indexOf(true))
  })

  it('stops baking once settled, though the cache is past its cap', async () => {
    // The city at full HD: its chunks with fill gaps on and off pass the cap
    // on hidden chunks, so eviction reaches the slices in view.
    const renderer = new ParallaxRenderer(new World(12345, 'city'), { bakery: new WorkerBakery([new FakeWorker()]) })
    renderer.resize(1920, 1080)
    await settle(renderer)
    renderer.setFillGaps(false)
    await settle(renderer)
    expect(renderer.getStats().lastUpdate?.cachedPixels).toBeGreaterThan(32_000_000)
    // settle()'s last render evicted; did it drop chunks the view wants but does not draw?
    renderer.render()
    expect(pending(renderer)).toBe(0)
  }, 60_000)

  it('bakes no cell nearer layers cover, and ends up showing the same', () => {
    // Bakes a few of the wanted chunks per render, as workers slower than renders do.
    const settled = (skip: boolean) => {
      const baker = new ChunkBaker(world.grid)
      let wanted: ChunkRequest[] = []
      let deliver: Parameters<Bakery['connect']>[0] = () => undefined
      const renderer = new ParallaxRenderer(world, { bakery: { connect(d) { deliver = d }, setWorld() {}, want(r) { wanted = r } } })
      renderer.resize(800, 600)
      // Among the trees, near the ground.
      renderer.setCamera({ x: 0, y: 15, z: 0 })
      renderer.setSkipCovered(skip)
      let bakes = 0
      for (renderer.render(); wanted.length > 0; renderer.render()) {
        for (const request of wanted.slice(0, 50)) deliver(request, baker.bake(request))
        bakes += Math.min(50, wanted.length)
      }
      return { bakes, picture: picture(renderer.render(), 4) }
    }
    const [skipping, all] = [settled(true), settled(false)]
    expect(skipping.picture).toEqual(all.picture)
    // ~150 against ~3500.
    expect(skipping.bakes).toBeLessThan(all.bakes / 4)
  })

  it('while slices re-tile, shows the slices they replace until the new ones are baked', async () => {
    const renderer = workerRenderer()
    // Among the trees, near the ground.
    renderer.setCamera({ x: 0, y: 15, z: 0 })
    await settle(renderer)
    // Up and forward: slices re-tile, and nothing is baked for them yet.
    // Cells that come out from behind nearer ones show nothing until baked.
    renderer.setCamera({ x: 0, y: 35, z: 30 })
    const moved = picture(renderer.render(), 4)
    expect(pending(renderer)).toBeGreaterThan(0)
    const target = new ParallaxRenderer(world)
    target.resize(800, 600)
    target.setCamera(renderer.getCamera())
    const settled = picture(target.render(), 4)
    const drawn = settled.filter(p => p !== 0).length
    const gaps = settled.filter((p, k) => p !== 0 && moved[k] === 0).length
    expect(drawn).toBeGreaterThan(settled.length / 4)
    // Without stand-ins, ~15%.
    expect(gaps).toBeLessThan(drawn / 10)
  })

  it('drops chunks baked from a replaced world', async () => {
    const request = { face: '+x+z', depth: 0, size: 64, i: 0, j: 0, tanX: 0, tanY: 0, fillDetail: 0 }
    expect(new ChunkBaker(world.grid).bake(request).facesDrawn).toBeGreaterThan(0)

    const bakery = new WorkerBakery([new FakeWorker()])
    const delivered: number[] = []
    bakery.connect((_, image) => { delivered.push(image.facesDrawn) })
    bakery.setWorld(world.grid)
    bakery.want([request])
    bakery.setWorld(VoxelGrid.fromVoxels([]))
    bakery.want([request])
    await tick()
    expect(delivered).toEqual([0])
  })

  it('bakes the new world after regeneration', async () => {
    const renderer = workerRenderer()
    renderer.regenerateWorld(99999, 'hills_with_trees')
    expect(shown(await settle(renderer))).toEqual(reference(undefined, new World(99999, 'hills_with_trees')))
  })
})
