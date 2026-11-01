/** Bake worker entry: see WorkerBakery and bakeHandler. */
import { bakeHandler, type BakeMessage } from './chunk-baker'

// The DOM typings describe `self` as a window; in a worker it is the worker's global scope.
const scope = self as unknown as Worker
const handle = bakeHandler((result, transfer) => { scope.postMessage(result, transfer) })
scope.onmessage = (event: MessageEvent<BakeMessage>) => { handle(event.data) }
