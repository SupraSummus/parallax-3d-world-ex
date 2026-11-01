import { describe, it, expect } from 'vitest'
import { bakeHandler, ChunkBaker, type BakeMessage, type BakeResult } from './chunk-baker'
import { ParallaxRenderer, type Camera, type Frame } from './renderer'
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
  ({ cellX: chunk.x, cellY: chunk.y, tanX: chunk.tanX, tanY: chunk.tanY, pixels: checksum(chunk.pixels), x, y })))

/** What baking on the main thread shows. */
function reference(camera?: Camera, from = world) {
  const renderer = new ParallaxRenderer(from)
  renderer.resize(800, 600)
  if (camera) renderer.setCamera(camera)
  return shown(renderer.render())
}

describe('WorkerBakery', () => {
  it('ends up showing what baking on the main thread shows', async () => {
    const renderer = workerRenderer()
    expect(shown(renderer.render()).flat()).toEqual([])
    expect(shown(await settle(renderer))).toEqual(reference())
  })

  it("shows a cell's older bake while its new direction is baking", async () => {
    const renderer = workerRenderer()
    await settle(renderer)
    // Far enough sideways that the nearest slices' directions change.
    renderer.setCamera({ x: renderer.getCamera().x + 3 })
    const baking = shown(renderer.render())
    const target = reference(renderer.getCamera())
    const standIns = baking.flatMap((layer, i) => layer.filter(c =>
      target[i].some(t => t.cellX === c.cellX && t.cellY === c.cellY && (t.tanX !== c.tanX || t.tanY !== c.tanY))))
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
    // A few, out of ~1700.
    expect(wasted).toBeLessThan(leftBehind / 50)
  })

  it('drops chunks baked from a replaced world', async () => {
    const request = { depth: 0, size: 64, x: 0, y: 0, tanX: 0, tanY: 0 }
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
