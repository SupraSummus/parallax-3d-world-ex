/**
 * Baking whole chunks: from a chunk request to its pixels, by the baker in
 * bake/ (Rust, compiled to WebAssembly and inlined here). Used by the
 * renderer directly (without workers) and inside bake workers, through the
 * message protocol below. No DOM.
 */
import wasm from '../../bake/target/wasm32-unknown-unknown/release/bake.wasm?inline'
import { shadedPalette, VOXEL_GEOMETRY } from './bake'
import { FACES } from './view'
import type { VoxelData } from './voxel-grid'

/**
 * A chunk to bake: cell (i, j) (see chunkCell) of the slice
 * [depth, depth + size) of a face (by name, see FACES), seen along
 * (tanX, tanY, 1), in the face's coordinates, with faces grown to fill
 * gaps for slices of `fillDetail` (0 for none; see docs/architecture.md,
 * section 3).
 */
export interface ChunkRequest {
  face: string
  depth: number
  size: number
  i: number
  j: number
  tanX: number
  tanY: number
  fillDetail: number
}

/** A baked chunk's pixels, cropped to what is drawn. */
export interface ChunkImage {
  /** Size in pixels; see originX/originY. */
  width: number
  height: number
  /** RGBA, rows top to bottom; transparent where nothing is drawn. */
  pixels: Uint32Array
  /**
   * A byte per block of 4 × 4 pixels, in rows: whether all its pixels are
   * drawn, and whether some are (solid_blocks in bake/src/fill.rs), for
   * finding what the chunk hides and whether it is hidden (occlusion.ts).
   */
  blocks: Uint8Array
  /** x, y of the top-left pixel's corner, in face coordinates. */
  originX: number
  originY: number
  /** Pixels per world unit (render_scale in bake/src/lib.rs). */
  scale: number
  /** Number of voxel faces drawn. */
  facesDrawn: number
}

/** The baker's exports (bake/src/lib.rs). */
interface Baker {
  memory: WebAssembly.Memory
  world_cells: (cells: number, materials: number) => number
  world_table: (table: number) => number
  world_ready: (minX: number, minY: number, minZ: number, nx: number, ny: number, nz: number) => void
  bake: Call
  faces: Call
}
type Call = (face: number, depth: number, size: number, i: number, j: number, tanX: number, tanY: number, detail: number) => number

/**
 * @internal Numbers per face in ChunkBaker.faces: its four corners on the
 * centre plane (x0, y0, …, x3, y3), its colour (an index into
 * shadedPalette), 1 if a ray along the baking direction reaches it, its
 * growth (left, bottom, right, top) and its voxel's site (a, b, c). See
 * bake/src/faces.rs.
 */
export const FACE = 17

// Compiled on first use, once per thread, synchronously
// (browsers allow that for a module this small even on the main thread).
let compiled: WebAssembly.Module | null = null
const bakerModule = () => (compiled ??= new WebAssembly.Module(Uint8Array.from(atob(wasm.slice(wasm.indexOf(',') + 1)), c => c.charCodeAt(0))))

/** A new instance of the module, with its own memory: for baking a world, or for Coverage (occlusion.ts). */
export function bakerInstance(): WebAssembly.Exports {
  return new WebAssembly.Instance(bakerModule()).exports
}

const faceIndex = new Map(FACES.map((face, index) => [face.name, index]))

/**
 * Bakes chunks of one world: a WebAssembly instance holding a copy of the
 * grid, the palette of each face, and the surfaces of recently baked cells.
 */
export class ChunkBaker {
  private baker: Baker

  constructor({ minX, minY, minZ, nx, ny, nz, cells, materials }: VoxelData) {
    const baker = bakerInstance() as unknown as Baker
    // Memory may grow on each call, detaching earlier views of it.
    const write = <T extends Uint8Array | Int32Array | Uint32Array | Float64Array>(View: new (buffer: ArrayBuffer, offset: number, length: number) => T, offset: number, values: T) => {
      new View(baker.memory.buffer, offset, values.length).set(values)
    }
    write(Uint8Array, baker.world_cells(cells.length, materials.length), cells)
    write(Float64Array, baker.world_table(0), VOXEL_GEOMETRY)
    write(Int32Array, baker.world_table(1), Int32Array.from(FACES.flatMap(({ lattice: { right, up, forward } }) => [right, up, forward].flatMap(v => [v.x, v.y, v.z]))))
    const palettes = FACES.map(face => shadedPalette(materials, face.lattice))
    palettes.forEach((palette, f) => { write(Uint32Array, baker.world_table(2) + f * palette.byteLength, palette) })
    baker.world_ready(minX, minY, minZ, nx, ny, nz)
    this.baker = baker
  }

  /**
   * Rasterises one chunk: the slice baked along (tanX, tanY, 1) onto its
   * centre plane (docs/architecture.md, section 3), clipped to the chunk's
   * cell and cropped to what is drawn there. A chunk no face reaches has no
   * pixels.
   */
  bake(request: ChunkRequest): ChunkImage {
    const { memory } = this.baker
    const result = this.call(this.baker.bake, request, 9)
    const [width, height, originX, originY, scale, facesDrawn, pixels, blocks, blockCount] = result
    return {
      width,
      height,
      // Copied out: the baker reuses its buffers.
      pixels: new Uint32Array(memory.buffer, pixels, width * height).slice(),
      blocks: new Uint8Array(memory.buffer, blocks, blockCount).slice(),
      originX,
      originY,
      scale,
      facesDrawn,
    }
  }

  /** @internal The faces of a chunk before filling, FACE numbers each, far to near (for tests). */
  faces(request: ChunkRequest): Float64Array {
    const [count, at] = this.call(this.baker.faces, request, 2)
    return new Float64Array(this.baker.memory.buffer, at, count * FACE).slice()
  }

  /** Calls `bake` or `faces` and returns the first `length` numbers of its result. */
  private call(baker: Call, { face, depth, size, i, j, tanX, tanY, fillDetail }: ChunkRequest, length: number): Float64Array {
    const index = faceIndex.get(face)
    if (index === undefined) throw new Error(`no face ${face}`)
    // Before reading memory.buffer: the call may grow (and so replace) it.
    const at = baker(index, depth, size, i, j, tanX, tanY, fillDetail)
    if (at === 0) throw new Error('the baker has no world')
    return new Float64Array(this.baker.memory.buffer, at, length)
  }
}

/**
 * Messages to a bake worker: a new world, or a chunk to bake. `generation`
 * numbers worlds; the answer echoes it.
 */
export type BakeMessage =
  | { type: 'world'; grid: VoxelData }
  | { type: 'bake'; generation: number; request: ChunkRequest }

/** A bake worker's answer to a `bake` message. */
export interface BakeResult {
  generation: number
  request: ChunkRequest
  image: ChunkImage
}

/**
 * A bake worker's message handler: bakes each requested chunk and posts
 * the result, handing over its pixel buffer.
 */
export function bakeHandler(post: (result: BakeResult, transfer: Transferable[]) => void): (message: BakeMessage) => void {
  let baker: ChunkBaker | null = null
  return message => {
    if (message.type === 'world') {
      baker = new ChunkBaker(message.grid)
    } else if (baker) {
      const { generation, request } = message
      const image = baker.bake(request)
      post({ generation, request, image }, [image.pixels.buffer, image.blocks.buffer])
    }
  }
}
