import { selectSlices, leakFreeDetail, directionStep, nearestDirection, sliceCentre, chunkCell, chunkCells, cellMargin, matchTilings, sliceKey as sliceName, siteLayers, thickness, type SliceId } from './slice-selection'
import { ChunkBaker, type ChunkImage, type ChunkRequest } from './chunk-baker'
import { World, type Vec3, type WorldType } from './world'
import { LayerIndex, type VoxelData } from './voxel-grid'
import { Coverage } from './occlusion'
import { FACES, LAYER, faceTangents, inFace, focalLength, onScreen, screenBox, toLocal, type Face, type Orientation, type ScreenBox, type TangentBox, type View } from './view'

export type Camera = Vec3

/** A rasterised, aligned piece of a slice (see chunkCell). */
export interface Chunk extends ChunkImage {
  /** Its cell (see chunkCell). */
  i: number
  j: number
  /**
   * Baking direction (tangents): the chunk is the parallel projection of
   * its slice along (tanX, tanY, 1) onto the slice's centre plane.
   */
  tanX: number
  tanY: number
  /** Slice detail the faces are grown for, to fill gaps; 0 if not. See chunk_faces in bake/src/faces.rs. */
  fillDetail: number
}

/**
 * A chunk in a frame: x, y of its top-left corner on its layer's plane,
 * relative to the camera, in the face's coordinates. It spans chunk.width /
 * chunk.scale to the right and chunk.height / chunk.scale down.
 */
export interface Placement {
  chunk: Chunk
  x: number
  y: number
}

/**
 * What to draw, seen through `View` (see projector() in view.ts). Layers
 * go face by face, near to far; a face draws only its own rays (inFace in
 * view.ts), and nearer layers hide what is behind them. A layer is a
 * slice's centre plane, `distance` ahead of the camera along its face's
 * axis; the slice's sites are in the face's layers [depth, depth + size)
 * (see Face in view.ts, siteLayers). `fog` is the share of the horizon colour mixed into a
 * layer's pixels, and into the sky where no layer is drawn.
 */
export interface Frame extends View {
  fog: number
  layers: { face: Face; slice: SliceId; depth: number; size: number; distance: number; placements: Placement[]; fog: number }[]
}

export interface UpdateStats {
  renderTime: number
  /** Distance / max slice thickness, from the leak tolerance (see leakFreeDetail). */
  detail: number
  layerCount: number
  /** Non-empty chunks in view. */
  chunkCount: number
  chunksReused: number
  /** Chunks in view shown for the first time since they were baked. */
  chunksRegenerated: number
  /** Chunks in view still baking (with a Bakery); an older bake of the same cell, if any, stands in. */
  chunksPending: number
  /** Cells and chunks in view covered by nearer layers, so not drawn (see Coverage). */
  chunksCovered: number
  /** Voxel faces drawn into chunks baked since the previous render (including any whose content turned out to be off screen). */
  voxelsRendered: number
  /** Percentage of chunks in view served from the cache. */
  cacheEfficiency: number
  /** Pixels of all cached chunks, in view or not. */
  cachedPixels: number
}

export interface SessionStats {
  totalUpdates: number
  totalRenderTime: number
  totalChunksRegenerated: number
  totalVoxelsRendered: number
  averageCacheEfficiency: number
  lastUpdate: UpdateStats | null
}

// Field of view across the longer viewport side, in degrees (see focalLength).
export const DEFAULT_FOV = 90
export const MIN_FOV = 5
export const MAX_FOV = 120

// How many screen pixels of geometry that perspective would hide may show
// through the gaps between slices. Larger means thicker slices, fewer layers.
export const DEFAULT_MAX_LEAK = 16
export const MIN_MAX_LEAK = 1
export const MAX_MAX_LEAK = 64

// Visible depth range, relative to the camera: from NEAR_DEPTH to the render
// distance, in world units (a voxel's neighbours are √2 away, see fcc.ts).
const NEAR_DEPTH = 2
export const DEFAULT_RENDER_DISTANCE = 400
export const MIN_RENDER_DISTANCE = 40
export const MAX_RENDER_DISTANCE = 800

// Slices and chunks outside the view are kept so that moving or turning
// back reuses them, up to these caps (a face has about 150 slices, and 12 faces
// look all around). What is in view is never evicted.
const MAX_CACHED_SLICES = 2048
const MAX_HIDDEN_CHUNK_PIXELS = 48_000_000

// Exponential distance fog towards the horizon colour: at viewing distance d
// a voxel keeps exp(-d / fogDistance) of its own colour. The fog distance
// scales with the render distance so the far cut-off stays hazy.
export const FOG_PER_RENDER_DISTANCE = 0.7

function sliceKey(face: string, slice: SliceId): string {
  return `${face}:${sliceName(slice)}`
}

/** A cached slice and the chunks baked so far. */
interface Slice {
  id: SliceId
  /** Its voxels may be in its face's layers [depth, depth + size) (see siteLayers). */
  depth: number
  size: number
  /** Baked chunks by cell (keyed by cellKey). */
  cells: Map<number, CellChunks>
  /** Pixels of its chunks. */
  pixels: number
  /** By cellKey: the least and greatest b of the voxels its chunks may draw (see cellMargin), or null if none. */
  extents: Map<number, [number, number] | null>
}

/** The chunks baked of a cell, one per direction and growth, and the most recent one, shown while the one wanted is baking. */
interface CellChunks {
  chunks: Chunk[]
  latest: Chunk | undefined
}

/** A chunk to bake, how far ahead, and whether an older bake of its cell stands in meanwhile. */
interface Missing {
  request: ChunkRequest
  distance: number
  stale: boolean
}

/** One render's settings and what it gathers across slices. */
interface Pass {
  view: View
  /** See directionStep. */
  step: number
  fillDetail: number
  coverage: Coverage | null
  missing: Missing[]
  /** Chunks of the cells in view. */
  inView: Set<Chunk>
  /** Chunks in view still baking. */
  pending: number
}

/** A face as seen in one render: its part of the screen (see faceTangents), the camera in its coordinates, screenBox. */
interface FaceView {
  face: Face
  tangents: TangentBox
  camera: Vec3
  boxOf: ReturnType<typeof screenBox>
}

/** What drawSlice found: the layer's distance and placements, cells and chunks covered, and (probing) cells in view never baked. */
interface Drawn {
  distance: number
  placements: Placement[]
  covered: number
  unbaked: number
}

/** |v| for the v in [lo, hi] nearest to 0. */
const closestToZero = (lo: number, hi: number) => (lo > 0 ? lo : hi < 0 ? -hi : 0)

/** A number per cell: cells of a slice are far fewer than 2^20 across. */
function cellKey(i: number, j: number): number {
  return (i + 2 ** 20) * 2 ** 21 + j + 2 ** 20
}

/** The cell's chunk baked along (tanX, tanY), grown for fillDetail. */
function findChunk(cell: CellChunks | undefined, tanX: number, tanY: number, fillDetail: number): Chunk | undefined {
  if (!cell) return
  for (const chunk of cell.chunks) {
    if (chunk.tanX === tanX && chunk.tanY === tanY && chunk.fillDetail === fillDetail) return chunk
  }
}

/**
 * Bakes chunks off the main thread (see WorkerBakery). The renderer lists
 * the chunks it is missing on every render; each baked one comes back
 * through the callback given to connect().
 */
export interface Bakery {
  connect(deliver: (request: ChunkRequest, image: ChunkImage) => void): void
  /** Replaces the world; chunks of the previous one are no longer delivered. */
  setWorld(grid: VoxelData): void
  /** The chunks to bake, most wanted first. Replaces the previous list. */
  want(requests: ChunkRequest[]): void
}

export interface RendererOptions {
  /** Where chunks are baked. Without one, render() bakes every missing chunk itself before returning. */
  bakery?: Bakery
  /** Called whenever the bakery delivers chunks; render() again to show them. */
  onBaked?: () => void
}

/**
 * Renders a World as a stack of flat, cached slices, each split into chunks
 * so that only what is in view is rasterised. render() returns where each
 * chunk goes on screen; drawing it is the compositor's job. See
 * docs/architecture.md for the slicing and caching scheme.
 */
export class ParallaxRenderer {
  private world: World
  private camera: Camera
  private orientation: Orientation = { yaw: 0, pitch: 0 }
  private fov = DEFAULT_FOV
  private maxLeak = DEFAULT_MAX_LEAK
  private renderDistance = DEFAULT_RENDER_DISTANCE
  private fillGaps = true
  private skipCovered = true
  private width = 0
  private height = 0

  // Keyed by sliceKey(face, slice). Map insertion order doubles as
  // LRU order (oldest first).
  private slices = new Map<string, Slice>()
  // Per face, the slices it drew (see matchTilings).
  private tilings = new Map<string, SliceId[]>()
  // Chunks of the cells in view in the most recent render, drawn or not:
  // evicted, one would be baked again on the next render.
  private inView = new Set<Chunk>()
  // Pixels of all cached chunks.
  private pixels = 0
  // Kept across renders for its buffers.
  private coverage: Coverage | null = null

  // Where each face's layers hold voxels, found on first use.
  private index: LayerIndex | null = null

  private bakery: Bakery | null
  private onBaked: () => void
  // Bakes on the main thread when there is no bakery.
  private baker: ChunkBaker | null = null
  // Baked but not shown yet: counted as regenerated when first shown.
  private fresh = new WeakSet<Chunk>()
  // Faces baked since the last render.
  private facesBaked = 0

  private stats: SessionStats = {
    totalUpdates: 0,
    totalRenderTime: 0,
    totalChunksRegenerated: 0,
    totalVoxelsRendered: 0,
    averageCacheEfficiency: 0,
    lastUpdate: null,
  }

  constructor(world: World, { bakery, onBaked }: RendererOptions = {}) {
    this.world = world
    this.camera = { ...world.spawn }
    this.bakery = bakery ?? null
    this.onBaked = onBaked ?? (() => undefined)
    this.bakery?.connect((request, image) => { this.receive(request, image) })
    this.useWorld()
  }

  render(): Frame {
    const startTime = performance.now()

    const detail = this.getDetail()
    const view = this.view()
    if (this.skipCovered) {
      if (this.coverage) this.coverage.setView(view)
      else this.coverage = new Coverage(view)
    }
    const pass: Pass = {
      view,
      step: directionStep(detail),
      fillDetail: this.fillGaps ? detail : 0,
      coverage: this.skipCovered ? this.coverage : null,
      missing: [],
      inView: new Set(),
      pending: 0,
    }

    let chunksRegenerated = 0
    let chunksReused = 0
    let chunksCovered = 0
    let farthest = this.renderDistance
    const frame: Frame = { ...view, fog: 0, layers: [] }
    // All slices of the view (also those still baking).
    const keep = new Set<Slice>()
    const tilings = new Map<string, SliceId[]>()

    for (const face of FACES) {
      // The face's part of the screen, on a plane at distance d: tangents · d around the camera.
      const tangents = faceTangents(view, face)
      if (!tangents) continue
      const camera = toLocal(face, this.camera)
      pass.coverage?.setFace(face)
      const of = { face, tangents, camera, boxOf: screenBox(view, face) }
      const drawn: SliceId[] = []
      const commit = (slice: Slice, result: Drawn) => {
        const { id, depth, size } = slice
        for (const { chunk } of result.placements) {
          if (this.fresh.delete(chunk)) chunksRegenerated++
          else chunksReused++
        }
        chunksCovered += result.covered
        farthest = Math.max(farthest, result.distance)
        frame.layers.push({ face, slice: id, depth, size, distance: result.distance, placements: result.placements, fog: this.fog(result.distance) })
        pass.coverage?.cover(result.placements, result.distance, id.level, camera)
        drawn.push(id)
      }

      const wanted = selectSlices(camera.z / LAYER, NEAR_DEPTH / LAYER, this.renderDistance / LAYER, detail)
      for (const segment of matchTilings(wanted, this.tilings.get(face.name) ?? [])) {
        const slices = segment.wanted.map(id => this.getSlice(face, id))
        for (const slice of slices) keep.add(slice)
        // If the slices re-tiled, the ones they replace stand in until they
        // have something in every cell they show (baking on the main thread,
        // they always have).
        const standIns = this.baker ? null : this.standIns(face, segment.previous, slices)
        if (!standIns || slices.every(slice => this.drawSlice(pass, of, slice, 'probe').unbaked === 0)) {
          for (const slice of slices) commit(slice, this.drawSlice(pass, of, slice, 'want'))
          continue
        }
        // Not drawn, but their chunks are baked.
        for (const slice of slices) this.drawSlice(pass, of, slice, 'want')
        for (const slice of standIns) {
          keep.add(slice)
          commit(slice, this.drawSlice(pass, of, slice, 'standIn'))
        }
      }
      tilings.set(face.name, drawn)
    }
    // The last slice may reach past the render distance; the sky is behind it.
    frame.fog = this.fog(farthest)

    this.inView = pass.inView
    this.tilings = tilings
    this.evict(keep)
    const nearFirst = (missing: Missing[]) => missing.sort((a, b) => a.distance - b.distance).map(m => m.request)
    // Cells that show nothing go first: while the camera moves, near chunks
    // change direction all the time and would keep the workers from ever
    // reaching them.
    this.bakery?.want([...nearFirst(pass.missing.filter(m => !m.stale)), ...nearFirst(pass.missing.filter(m => m.stale))])
    const voxelsRendered = this.facesBaked
    this.facesBaked = 0

    const chunkCount = chunksReused + chunksRegenerated
    const renderTime = performance.now() - startTime
    const cacheEfficiency = chunkCount > 0 ? (chunksReused / chunkCount) * 100 : 100
    const s = this.stats
    s.totalUpdates++
    s.totalRenderTime += renderTime
    s.totalChunksRegenerated += chunksRegenerated
    s.totalVoxelsRendered += voxelsRendered
    s.averageCacheEfficiency += (cacheEfficiency - s.averageCacheEfficiency) / s.totalUpdates
    s.lastUpdate = {
      renderTime,
      detail,
      layerCount: frame.layers.length,
      chunkCount,
      chunksReused,
      chunksRegenerated,
      chunksPending: pass.pending,
      chunksCovered,
      voxelsRendered,
      cacheEfficiency,
      cachedPixels: this.pixels,
    }
    return frame
  }

  /** The cached slices `previous`, if they differ from `slices` and are all still cached. */
  private standIns(face: Face, previous: SliceId[], slices: Slice[]): Slice[] | null {
    const cached = previous.map(id => this.slices.get(sliceKey(face.name, id)))
    if (cached.length === 0 || cached.some(s => !s)) return null
    if (cached.length === slices.length && cached.every((s, k) => s === slices[k])) return null
    return cached as Slice[]
  }

  /**
   * The b of the voxels the chunks of a slice's cell may draw (see
   * cellMargin), or null if there are none; found on first use.
   */
  private cellExtent(face: Face, slice: Slice, i: number, j: number): [number, number] | null {
    const key = cellKey(i, j)
    let extent = slice.extents.get(key)
    if (extent === undefined) {
      const { id, depth, size } = slice
      const { x, y, width, height } = chunkCell(id.level, i, j)
      // The cell's sites, in lattice units.
      const [left, right] = [x, x + width].map(v => Math.round(v / LAYER))
      const [bottom, top] = [y, y + height]
      const margin = cellMargin(id.level)
      const found = this.layerIndex().range(face.lattice, depth, depth + size, left - margin.columns, right + margin.columns)
      const lo = found ? Math.max(found[0], bottom - margin.rows) : 0
      const hi = found ? Math.min(found[1], top + margin.rows) : -1
      extent = lo <= hi ? [lo, hi] : null
      slice.extents.set(key, extent)
    }
    return extent
  }

  /**
   * The chunks of a slice to draw, near to far within it, given what nearer
   * layers cover. Chunks it is missing are baked (without a bakery) or
   * listed to bake if it is `want`ed; a slice standing in for one that
   * re-tiled shows what it has. A `probe` only counts the cells in view
   * never baked.
   */
  private drawSlice(pass: Pass, { face, tangents, camera, boxOf }: FaceView, slice: Slice, mode: 'want' | 'standIn' | 'probe'): Drawn {
    const { view, step, fillDetail, coverage, inView } = pass
    const { id } = slice
    const { level, layer, cutoff } = id
    // Slices start at least NEAR_DEPTH ahead of the camera, so this is > 0.
    const distance = sliceCentre(id) - camera.z
    const result: Drawn = { distance, placements: [], covered: 0, unbaked: 0 }
    const covered = (box: ScreenBox) => {
      const c = coverage?.hides(box) ?? false
      if (c) result.covered++
      return c
    }

    // The bounding box of the face's part of the slice's plane.
    const left = camera.x + tangents.minX * distance
    const right = camera.x + tangents.maxX * distance
    const bottom = camera.y + tangents.minY * distance
    const top = camera.y + tangents.maxY * distance
    // How far from its voxel's b a face may be drawn (see chunk_faces in
    // bake/src/faces.rs): a voxel's extent, baking along tangents up to
    // LAYER in y over half the slice's thickness, and growth to fill gaps,
    // by at most the span of rays through the cell (with its margin) off
    // its direction.
    const h = chunkCell(level, 0, 0).height
    const half = (thickness(level) / 2) * LAYER
    const growth = fillDetail > 0 ? (h / 2 + cellMargin(level).rows + 1 + half) / ((thickness(level) - 1) * fillDetail * LAYER) + step / 2 : 0
    const extentReach = 1.5 + (LAYER + growth) * half
    for (const [i, j] of chunkCells(level, left, right, bottom, top)) {
      const cellRect = chunkCell(level, i, j)
      // Nothing to draw: not baked at all. Otherwise, what it draws lies within reach of its voxels.
      const extent = this.cellExtent(face, slice, i, j)
      if (!extent) continue
      const x0 = cellRect.x - camera.x
      const x1 = x0 + cellRect.width
      const y0 = Math.max(cellRect.y, extent[0] - extentReach) - camera.y
      const y1 = Math.min(cellRect.y + h, extent[1] + extentReach) - camera.y
      if (y0 >= y1) continue
      // The face draws only its own rays: the cell must reach its rhombus (inFace).
      if (!inFace(closestToZero(x0, x1), closestToZero(y0, y1), distance)) continue
      // The screen shows a quadrilateral of the plane, less than its bounding box.
      const cellBox = boxOf(x0, x1, y0, y1, distance)
      if (!onScreen(view, cellBox)) continue
      // Bake along the grid direction nearest to the ray through the cell's centre,
      // within the face's rays: the rays shown are, and baking needs it
      // (see chunk_faces in bake/src/faces.rs).
      // + 0 turns −0 into 0: a direction is part of the chunk's name.
      const tanX = Math.max(-1, Math.min(1, nearestDirection((cellRect.x + cellRect.width / 2 - camera.x) / distance, step))) + 0
      const maxY = (1 - Math.abs(tanX)) * LAYER
      const tanY = Math.max(-maxY, Math.min(maxY, nearestDirection((cellRect.y + h / 2 - camera.y) / distance, step))) + 0
      const cell = slice.cells.get(cellKey(i, j))
      let chunk = findChunk(cell, tanX, tanY, fillDetail)
      if (covered(cellBox)) {
        // Not drawn, nor baked, but kept if baked.
        const kept = chunk ?? cell?.latest
        if (kept) inView.add(kept)
        continue
      }
      if (mode === 'probe') {
        if (!chunk && !cell?.latest) result.unbaked++
        continue
      }
      if (!chunk) {
        // An older bake of the cell, if any, stands in.
        const latest = cell?.latest
        if (mode === 'standIn') {
          chunk = latest
        } else if (this.baker) {
          const request = { face: face.name, level, layer, cutoff, i, j, tanX, tanY, fillDetail }
          chunk = this.store(request, this.baker.bake(request))
        } else {
          // Not wanted if what stands in is hidden anyway.
          if (latest && coverage && latest.facesDrawn > 0 && coverage.hidesChunk(latest, latest.originX - camera.x, latest.originY - camera.y, distance)) {
            inView.add(latest)
            result.covered++
            continue
          }
          pass.pending++
          pass.missing.push({ request: { face: face.name, level, layer, cutoff, i, j, tanX, tanY, fillDetail }, distance, stale: !!latest })
          chunk = latest
        }
        if (!chunk) continue
      }
      inView.add(chunk)
      if (chunk.facesDrawn === 0) continue
      // The chunk's content, not just its cell, must reach the screen.
      const contentLeft = chunk.originX - camera.x
      const contentTop = chunk.originY - camera.y
      const box = boxOf(contentLeft, contentLeft + chunk.width / chunk.scale, contentTop - chunk.height / chunk.scale, contentTop, distance)
      if (!onScreen(view, box)) continue
      if (coverage?.hidesChunk(chunk, contentLeft, contentTop, distance)) {
        result.covered++
        continue
      }
      result.placements.push({ chunk, x: contentLeft, y: contentTop })
    }
    return result
  }

  getCamera(): Camera {
    return { ...this.camera }
  }

  setCamera(camera: Partial<Camera>) {
    this.camera = { ...this.camera, ...camera }
  }

  getOrientation(): Orientation {
    return { ...this.orientation }
  }

  /** Turns the view; pitch stops at straight up or down, yaw wraps to [-180, 180). */
  setOrientation(orientation: Partial<Orientation>) {
    const { yaw, pitch } = { ...this.orientation, ...orientation }
    this.orientation = { yaw: yaw - 360 * Math.floor((yaw + 180) / 360), pitch: Math.min(90, Math.max(-90, pitch)) }
  }

  getWorld(): World {
    return this.world
  }

  getStats(): SessionStats {
    return { ...this.stats }
  }

  /** Sets the viewport size in CSS pixels. Cached chunks stay valid; call render() to reposition them. */
  resize(width: number, height: number) {
    this.width = width
    this.height = height
  }

  /** Replaces the world and moves the camera to its spawn point. */
  regenerateWorld(seed?: number, worldType?: WorldType) {
    this.world = new World(seed, worldType)
    this.camera = { ...this.world.spawn }
    this.inView.clear()
    this.tilings.clear()
    this.slices.clear()
    this.pixels = 0
    this.index = null
    this.facesBaked = 0
    this.useWorld()
  }

  private useWorld() {
    if (this.bakery) this.bakery.setWorld(this.world.grid)
    else this.baker = new ChunkBaker(this.world.grid)
  }

  getFov(): number {
    return this.fov
  }

  /**
   * Sets the field of view in degrees (clamped to [MIN_FOV, MAX_FOV]). It
   * zooms, and changes the focal length the slicing depends on (see
   * bakeAngleError).
   */
  setFov(fov: number) {
    this.fov = Math.min(MAX_FOV, Math.max(MIN_FOV, fov))
  }

  getRenderDistance(): number {
    return this.renderDistance
  }

  /** Sets how far ahead slices are drawn (clamped to [MIN_RENDER_DISTANCE, MAX_RENDER_DISTANCE]). */
  setRenderDistance(distance: number) {
    this.renderDistance = Math.min(MAX_RENDER_DISTANCE, Math.max(MIN_RENDER_DISTANCE, distance))
  }

  getMaxLeak(): number {
    return this.maxLeak
  }

  /**
   * Sets how many screen pixels of hidden geometry may show between slices
   * (clamped to [MIN_MAX_LEAK, MAX_MAX_LEAK]). Slices are keyed by level and
   * layer, so the ones still needed stay cached.
   */
  setMaxLeak(pixels: number) {
    this.maxLeak = Math.min(MAX_MAX_LEAK, Math.max(MIN_MAX_LEAK, pixels))
  }

  /** Whether faces are grown to fill the gaps between slices (see chunk_faces in bake/src/faces.rs). */
  setFillGaps(fill: boolean) {
    this.fillGaps = fill
  }

  /** Whether chunks covered by nearer layers are skipped: not drawn, and baked last (see Coverage). */
  setSkipCovered(skip: boolean) {
    this.skipCovered = skip
  }

  /**
   * Slice detail that keeps occlusion leaks within the tolerance on the
   * current viewport. A face draws rays within tangent 1 of its axis,
   * however the camera is turned, so turning keeps the slices.
   */
  getDetail(): number {
    return leakFreeDetail(focalLength(this.fov, this.width, this.height), 1, this.maxLeak)
  }

  private view(): View {
    return {
      orientation: this.orientation,
      width: this.width,
      height: this.height,
      focal: focalLength(this.fov, this.width, this.height),
    }
  }

  /** Share of the fog colour at viewing distance d. */
  private fog(d: number): number {
    return 1 - Math.exp(-d / (this.renderDistance * FOG_PER_RENDER_DISTANCE))
  }

  private layerIndex(): LayerIndex {
    return (this.index ??= new LayerIndex(this.world.grid, FACES.map(f => f.lattice)))
  }

  /** Returns the cached slice, or a new one with no chunks. */
  private getSlice(face: Face, id: SliceId): Slice {
    const key = sliceKey(face.name, id)
    const cached = this.slices.get(key)
    if (cached) {
      // Re-insert to mark as most recently used.
      this.slices.delete(key)
      this.slices.set(key, cached)
      return cached
    }

    const start = id.layer * 2 ** id.level
    const [first, last] = siteLayers(id.level)
    const slice: Slice = {
      id,
      depth: start + first,
      size: last - first + 1,
      cells: new Map(),
      pixels: 0,
      extents: new Map(),
    }
    this.slices.set(key, slice)
    return slice
  }

  /** Caches a baked chunk, unless its slice has been evicted meanwhile. */
  private store(request: ChunkRequest, image: ChunkImage): Chunk | undefined {
    const { face, level, layer, cutoff, i, j, tanX, tanY, fillDetail } = request
    const slice = this.slices.get(sliceKey(face, { level, layer, cutoff }))
    if (!slice) return
    const key = cellKey(i, j)
    let cell = slice.cells.get(key)
    if (!cell) slice.cells.set(key, cell = { chunks: [], latest: undefined })
    if (findChunk(cell, tanX, tanY, fillDetail)) return
    const chunk: Chunk = { ...image, i, j, tanX, tanY, fillDetail }
    cell.chunks.push(chunk)
    cell.latest = chunk
    slice.pixels += chunk.width * chunk.height
    this.pixels += chunk.width * chunk.height
    this.fresh.add(chunk)
    this.facesBaked += chunk.facesDrawn
    return chunk
  }

  private receive(request: ChunkRequest, image: ChunkImage) {
    this.store(request, image)
    this.onBaked()
  }

  /**
   * Drops least-recently-used slices beyond MAX_CACHED_SLICES, then hidden
   * chunks (least recently used slices first) until they fit
   * MAX_HIDDEN_CHUNK_PIXELS. What is in view is never evicted.
   */
  private evict(inView: Set<Slice>) {
    for (const [key, slice] of this.slices) {
      if (this.slices.size <= MAX_CACHED_SLICES) break
      if (inView.has(slice)) continue
      this.slices.delete(key)
      this.pixels -= slice.pixels
    }
    let hidden = this.pixels
    for (const chunk of this.inView) hidden -= chunk.width * chunk.height
    for (const slice of this.slices.values()) {
      if (hidden <= MAX_HIDDEN_CHUNK_PIXELS) return
      for (const [key, cell] of slice.cells) {
        const kept = cell.chunks.filter(chunk => this.inView.has(chunk))
        for (const chunk of cell.chunks) {
          if (this.inView.has(chunk)) continue
          const pixels = chunk.width * chunk.height
          hidden -= pixels
          slice.pixels -= pixels
          this.pixels -= pixels
        }
        if (kept.length === 0) {
          slice.cells.delete(key)
        } else {
          cell.chunks = kept
          if (cell.latest && !this.inView.has(cell.latest)) cell.latest = undefined
        }
      }
    }
  }
}
