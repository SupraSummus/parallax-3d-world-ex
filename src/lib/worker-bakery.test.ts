import { describe, it, expect } from 'vitest'
import { bakeHandler, ChunkBaker, type BakeMessage, type BakeResult, type ChunkRequest } from './chunk-baker'
import { ParallaxRenderer, type Camera, type Frame } from './renderer'
import type { Orientation } from './view'
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

/** A chunk's cell: its slice and corner. */
const cell = ({ depth, size, x, y }: ChunkRequest) => [depth, size, x, y].join()

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
    expect(faces.size).toBe(yaw === 0 ? 1 : 3)
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
    // At most what was in flight, out of ~1700.
    expect(wasted).toBeLessThan(leftBehind / 20)
  })

  it('bakes cells that show nothing before rebaking cells an older bake stands in for', async () => {
    const bakery = new RecordingBakery([new FakeWorker(), new FakeWorker()])
    const renderer = new ParallaxRenderer(world, { bakery })
    renderer.resize(800, 600)
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

  it('drops chunks baked from a replaced world', async () => {
    const request = { face: '+z', depth: 0, size: 64, x: 0, y: 0, tanX: 0, tanY: 0, spread: 0 }
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
