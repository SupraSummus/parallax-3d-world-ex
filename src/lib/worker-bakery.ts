import type { BakeMessage, BakeResult, ChunkImage, ChunkRequest } from './chunk-baker'
import type { Bakery } from './renderer'
import type { VoxelData } from './voxel-grid'

/** The part of a Worker a WorkerBakery uses. */
export interface BakeWorker {
  postMessage(message: BakeMessage): void
  onmessage: ((event: MessageEvent<BakeResult>) => void) | null
  terminate(): void
}

// Requests sent to a worker and not answered yet. A worker gets more only
// when the main thread is free to take its answers, so this must cover
// a busy frame (4 was too few to keep up with a moving camera);
// what is in flight when the camera moves on is wasted.
const MAX_IN_FLIGHT = 32

const requestKey = ({ face, depth, size, x, y, tanX, tanY, fillDetail }: ChunkRequest) => [face, depth, size, x, y, tanX, tanY, fillDetail].join()

/**
 * Bakes chunks in a pool of workers (bake.worker.ts), each with its own copy
 * of the world. Requests go out in the order the latest want() listed them,
 * to whichever worker has the fewest in flight.
 */
export class WorkerBakery implements Bakery {
  private workers: { worker: BakeWorker; inFlight: number }[]
  private generation = 0
  // The latest wanted list, and how far into it requests have been sent.
  private queue: ChunkRequest[] = []
  private next = 0
  // Keys of the current world's requests in flight.
  private sent = new Set<string>()
  private deliver: (request: ChunkRequest, image: ChunkImage) => void = () => undefined

  constructor(workers: BakeWorker[]) {
    this.workers = workers.map(worker => {
      const entry = { worker, inFlight: 0 }
      worker.onmessage = event => { this.receive(entry, event.data) }
      return entry
    })
  }

  connect(deliver: (request: ChunkRequest, image: ChunkImage) => void) {
    this.deliver = deliver
  }

  setWorld(grid: VoxelData) {
    this.generation++
    this.queue = []
    this.next = 0
    this.sent.clear()
    for (const { worker } of this.workers) worker.postMessage({ type: 'world', grid })
  }

  want(requests: ChunkRequest[]) {
    this.queue = requests
    this.next = 0
    this.pump()
  }

  /** Stops the workers; requests in flight are never delivered. */
  dispose() {
    for (const { worker } of this.workers) worker.terminate()
    this.workers = []
  }

  private receive(entry: { inFlight: number }, { generation, request, image }: BakeResult) {
    entry.inFlight--
    // A worker answers in order, so results of an older world arrive before
    // the new world's; they are dropped.
    if (generation === this.generation) {
      this.sent.delete(requestKey(request))
      this.deliver(request, image)
    }
    this.pump()
  }

  private pump() {
    while (this.next < this.queue.length && this.workers.length > 0) {
      const target = this.workers.reduce((a, b) => (b.inFlight < a.inFlight ? b : a))
      if (target.inFlight >= MAX_IN_FLIGHT) return
      const request = this.queue[this.next++]
      const key = requestKey(request)
      if (this.sent.has(key)) continue
      this.sent.add(key)
      target.inFlight++
      target.worker.postMessage({ type: 'bake', generation: this.generation, request })
    }
  }
}

/** A WorkerBakery with `count` workers. */
export function startBakeWorkers(count: number): WorkerBakery {
  return new WorkerBakery(Array.from({ length: count }, () =>
    new Worker(new URL('./bake.worker.ts', import.meta.url), { type: 'module' })))
}
