/** Bake worker entry: see WorkerBakery and bakeHandler. */
import { bakeHandler, type BakeMessage } from './chunk-baker'

// The DOM typings describe `self` as a window; in a worker it is the worker's global scope.
const scope = self as unknown as Worker
// Each step is a task of its own, so messages are handled between steps
// (nested setTimeout would wait 4 ms).
const steps = new MessageChannel()
const handle = bakeHandler(
  (result, transfer) => { scope.postMessage(result, transfer) },
  step => { steps.port1.onmessage = step; steps.port2.postMessage(null) },
)
scope.onmessage = (event: MessageEvent<BakeMessage>) => { handle(event.data) }
