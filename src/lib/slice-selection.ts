/**
 * Slice selection: decides which slices of a face's layers (view.ts) the
 * camera renders, how they are split into chunks, and along which
 * direction each chunk is baked. Depths count layers, LAYER apart.
 *
 * A slice is a slab of a face's layers between two layers of a coarser
 * lattice 2^k·FCC (k its level), made of cells of a finer one 2^ℓ·FCC
 * (its atoms, cells.ts): the sites whose cell has its own site in the
 * slab. Up to level ATOM_SHIFT the atoms are single voxels and a slab
 * is 2^k layers of them; above, a slab is 2^ATOM_SHIFT layers of cells. A
 * cell reaches past its layer into its neighbours' (cells of neighbouring
 * layers interlock, as voxels do), so the slab's voxels span a little more
 * than its 2^k layers. Its centre plane, where its chunks are baked and
 * drawn, is the middle of what they span. Near the camera slices are
 * single layers of voxels (level 0); farther away, thicker slabs.
 *
 * Constraints (see docs/architecture.md for the derivation and worked examples):
 *
 * 1. Occlusion (physical). A slice is drawn flat, so a thick slice can show
 *    geometry that true perspective hides. A slice at viewing distance d at
 *    most d / detail thick, with detail = leakFreeDetail(...), never shows
 *    more than `max leak` screen pixels of it. Far voxels are small on
 *    screen, so slices grow with distance and covering distance n takes
 *    O(detail · log n) slices.
 *
 * 2. Caching. A slice is named by its level and its slab (and its cutoff,
 *    see SliceId) wherever the camera is, so it always has the same content
 *    and can be cached.
 *
 * Walking away from the camera, each level takes over once its slices are
 * thin enough there. Slabs of levels with the same atoms nest; where the
 * atoms grow, cells of the two sizes do not nest, so the last slices of the
 * nearer level hold only the sites whose cell one size up lies before
 * where the next level begins.
 *
 * Slices are split in x and y into chunks: bricks (chunkCell), each the
 * shadow along the axis of a column of cells of a coarser lattice still.
 * Each chunk is baked as a parallel projection along a direction from a
 * power-of-two grid (directionStep) close to the camera's view of it. The
 * smaller the angle between that direction and the actual rays, the
 * thicker slices may be.
 */
import { owner, ownedLayers, spacing } from './cells'
import { LAYER } from './view'

/**
 * A slice: slab `layer` of `level`, i.e. the sites whose atom (the cell of
 * atomLevel(level) holding them) has its own site in layers
 * [layer · 2^level, (layer + 1) · 2^level). If `cutoff` is finite, only
 * those whose cell one atom size up has its site in a layer before
 * `cutoff`; the rest belong to the next level's slices.
 */
export interface SliceId {
  level: number
  layer: number
  cutoff: number
}

/** Slabs of more than 64 layers would not fit the leak bound before the render distance. @internal */
export const MAX_LEVEL = 6

/** Above level ATOM_SHIFT a slab is 2^ATOM_SHIFT layers of cells, not of voxels. */
const ATOM_SHIFT = 3

/** C: a chunk spans at most C · thickness layer spacings across. @internal */
export const CHUNK_SPAN = 16

/** The level of the cells (cells.ts) a slice of `level` is made of: 0, single voxels, up to ATOM_SHIFT. */
function atomLevel(level: number): number {
  return Math.max(0, level - ATOM_SHIFT)
}

/**
 * The layers its sites may be in, relative to the first layer of its
 * slab: its atoms' own sites are in the 2^level layers from there, every
 * N-th (N = 2^atomLevel), and each holds sites ownedLayers around its own.
 */
export function siteLayers(level: number): [number, number] {
  const [lo, hi] = ownedLayers(atomLevel(level))
  return [lo, 2 ** level - spacing(atomLevel(level)) + hi]
}

/** @internal Whether a slice holds site (a, b, c) (for tests; classify in bake/src/surface.rs). */
export function holds({ level, layer, cutoff }: SliceId, site: [number, number, number]): boolean {
  const n = spacing(atomLevel(level))
  return Math.floor(owner(n, site)[2] / 2 ** level) === layer && (cutoff === Infinity || owner(2 * n, site)[2] < cutoff)
}

/**
 * A slice's thickness in layer spacings: its voxels reach a layer past
 * their sites' (see fcc.ts). 2^level + 1 up to level ATOM_SHIFT, then
 * 2^level + N + 2 for cells of N = 2 and 2^level + N + 1 above.
 */
export function thickness(level: number): number {
  const [first, last] = siteLayers(level)
  return last - first + 2
}

/** Its near side, the near tips of its nearest voxels, in layers. */
function nearSide({ level, layer }: { level: number; layer: number }): number {
  return layer * 2 ** level + siteLayers(level)[0] - 1
}

/** A name for a slice of a face, the same wherever the camera is. */
export function sliceKey({ level, layer, cutoff }: SliceId): string {
  return `${String(level)}:${String(layer)}:${String(cutoff)}`
}

/**
 * M: the spacing of the lattice M·FCC whose columns of cells a slice of
 * `level` is split along, so that a chunk is 2 · M · LAYER = C · 2^level ·
 * LAYER across.
 */
function brickSpacing(level: number): number {
  return (CHUNK_SPAN / 2) * 2 ** level
}

/** A part of a slice's plane, in face coordinates: [x, x + width) × [y, y + height). */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Chunk (i, j) of a slice of `level`: brick i of row j. Seen along the
 * axis, the sites of M·FCC (M = brickSpacing) form rows M apart in b,
 * their a multiples of 2M in even rows and odd multiples of M in odd ones.
 * The brick around a site reaches M either way in a and M / 2 in b, so
 * the rows of bricks are offset by half a brick, like a wall's, and each
 * is the shadow of one column of cells of M·FCC. In lattice units a brick
 * is 2M across and M high; a chunk of a slice of level ≥ 1 is thickness ≥
 * 2^level + 1 layer spacings thick and at most its distance / detail, so
 * it spans less than C / detail radians on screen.
 */
export function chunkCell(level: number, i: number, j: number): Rect {
  const m = brickSpacing(level)
  return { x: (2 * i + (j & 1) - 1) * m * LAYER, y: (j - 0.5) * m, width: 2 * m * LAYER, height: m }
}

/** The chunks (i, j) of a slice of `level` that meet [left, right) × [bottom, top) of its plane, row by row. */
export function chunkCells(level: number, left: number, right: number, bottom: number, top: number): [number, number][] {
  const m = brickSpacing(level)
  const cells: [number, number][] = []
  for (let j = Math.floor(bottom / m + 0.5); (j - 0.5) * m < top; j++) {
    // Brick i of row j spans a in [(2i + odd − 1)·M, (2i + odd + 1)·M).
    const brick = (a: number) => (a / m - (j & 1) + 1) / 2
    for (let i = Math.floor(brick(left / LAYER)); i < brick(right / LAYER); i++) cells.push([i, j])
  }
  return cells
}

/**
 * How far gap filling may grow a face, as a tangent times the distance
 * from the slice's centre plane (MAX_REACH in bake/src/surface.rs).
 */
const MAX_REACH = 1

/**
 * How far around its cell a chunk of a slice of `level` may draw voxels
 * from, in lattice units: `columns` along a, `rows` along b (cell_margin in
 * bake/src/surface.rs). `rows` also bounds how far from a voxel's b its
 * faces may be drawn, with faces grown by at most MAX_REACH.
 */
export function cellMargin(level: number): { columns: number; rows: number } {
  const half = (thickness(level) / 2) * LAYER
  return { columns: Math.ceil(((1 + MAX_REACH) * half + 1.5) / LAYER), rows: Math.ceil((LAYER + MAX_REACH) * half + 1.5) }
}

/**
 * The largest angle error (as a tangent) between a ray and the direction its
 * chunk is baked along, given the focal length in pixels, the largest
 * tangent of a ray the slices are drawn for (1 for a face, see inFace) and the
 * leak tolerance ε in pixels.
 *
 * A slice of thickness s drawn at its centre misplaces an edge seen at
 * tangent τ_err off its baking direction by up to τ_err·s/2 world units; a
 * leak needs two such errors, so it is at most τ_err·s·focal/a pixels. With
 * s ≤ a / detail that is τ_err·focal/detail ≤ ε, so detail = τ_err·focal/ε.
 * Chunks span at most C / detail and directions are at most that far apart
 * (directionStep), so τ_err ≤ C / detail. Both hold for
 * τ_err = √(C·ε / focal). Rays are never more than maxTangent off a
 * straight-ahead bake, so τ_err is at most that.
 * @internal
 */
export function bakeAngleError(focal: number, maxTangent: number, maxLeakPixels: number): number {
  return Math.min(maxTangent, Math.sqrt((CHUNK_SPAN * maxLeakPixels) / focal))
}

/**
 * Detail (viewing distance / maximum slice thickness) that keeps occlusion
 * leaks at most `maxLeakPixels`: τ_err·focal/ε (see bakeAngleError).
 *
 * Rounded up to a quarter octave (denser slices are always safe), so small
 * changes of the viewport keep the slicing and the cache.
 */
export function leakFreeDetail(focal: number, maxTangent: number, maxLeakPixels: number): number {
  const detail = (bakeAngleError(focal, maxTangent, maxLeakPixels) * focal) / maxLeakPixels
  return detail <= 1 ? 1 : 2 ** (Math.ceil(4 * Math.log2(detail)) / 4)
}

/**
 * Spacing of baking directions (as tangents, in x and y): the largest power
 * of two ≤ C / detail. A chunk is baked along the grid direction nearest to
 * the ray through its centre.
 */
export function directionStep(detail: number): number {
  return 2 ** Math.floor(Math.log2(CHUNK_SPAN / detail))
}

/** The direction a chunk whose centre ray has `tangent` is baked along: the nearest multiple of `step`. */
export function nearestDirection(tangent: number, step: number): number {
  return Math.round(tangent / step) * step
}

/**
 * z (face coordinates) of a slice's centre plane, the plane its chunks are
 * baked onto and drawn at: halfway through what its voxels span, so they
 * reach thickness / 2 to either side.
 */
export function sliceCentre(slice: SliceId): number {
  return (nearSide(slice) + thickness(slice.level) / 2) * LAYER
}

/** The smallest multiple of n ≥ x. */
const alignUp = (x: number, n: number) => Math.ceil(x / n) * n

/**
 * Slices holding every site with c in [cameraZ + minRelativeDepth,
 * cameraZ + maxRelativeDepth), each in exactly one, sorted near to far;
 * all in layers. Beyond level 0 (single layers), no slice is thicker than
 * a / detail, where a is the distance to its near side.
 *
 * Level k holds the slabs from where it begins, `from`, to where the next
 * level begins, `until` (a multiple of the next level's slab, 2^(k+1)):
 * the first layer far enough for the next level's thickness. Where the
 * next level's atoms are larger, cells of two sizes meet at `until`: a
 * site's cell of the larger size may lie before it while its cell of the
 * smaller size lies after, and the other way round, by less than 3N (N the
 * smaller cells' spacing). So level k goes on to the slab at `until`, and
 * its slabs within reach (ending past until − 4N − 2) get `until` as their
 * cutoff; and it is at least 3N long, so that a site of its first slabs
 * never belongs to an earlier level.
 */
export function selectSlices(cameraZ: number, minRelativeDepth: number, maxRelativeDepth: number, detail: number): SliceId[] {
  if (minRelativeDepth >= maxRelativeDepth) return []
  const far = cameraZ + maxRelativeDepth
  const slices: SliceId[] = []
  // Round up: a slice closer than minRelativeDepth would be blown up over the screen.
  let from = Math.ceil(cameraZ + minRelativeDepth)
  for (let level = 0; ; level++) {
    const slab = 2 ** level
    const n = spacing(atomLevel(level))
    const first = siteLayers(level)[0]
    let until = Infinity
    let grows = false
    if (level < MAX_LEVEL) {
      const next = level + 1
      grows = atomLevel(next) > atomLevel(level)
      until = alignUp(Math.max(cameraZ - nearSide({ level: next, layer: 0 }) + thickness(next) * detail, from + (grows ? 3 * n : 0)), 2 * slab)
      // The next level's sites reach at most its first site layer before its slabs.
      if (until + siteLayers(next)[0] >= far) until = Infinity
    }
    const last = until === Infinity ? (m: number) => m * slab + first < far : grows ? (m: number) => m * slab <= until : (m: number) => m * slab < until
    for (let layer = Math.ceil(from / slab); last(layer); layer++) {
      slices.push({ level, layer, cutoff: grows && (layer + 1) * slab + 4 * n + 2 > until ? until : Infinity })
    }
    if (until === Infinity) return slices
    from = until
  }
}

/**
 * Pairs up two slicings of a face (near to far, as selectSlices returns
 * them): segments of consecutive `wanted` slices, each with the `previous`
 * slices it replaces. Slices in both are segments of their own, paired
 * with themselves; the ones between two of them, or before the first, are
 * paired with the previous slices there, which hold the same sites but for
 * a few at the ends. Wanted slices past the last shared one get none.
 */
export function matchTilings(wanted: SliceId[], previous: SliceId[]): { wanted: SliceId[]; previous: SliceId[] }[] {
  const index = new Map(previous.map((s, k) => [sliceKey(s), k]))
  const segments: { wanted: SliceId[]; previous: SliceId[] }[] = []
  let current: SliceId[] = []
  // The last slice found in both, by its index in `previous`.
  let shared = -1
  for (const slice of wanted) {
    const k = index.get(sliceKey(slice))
    if (k === undefined || k <= shared) {
      current.push(slice)
      continue
    }
    if (current.length > 0) segments.push({ wanted: current, previous: previous.slice(shared + 1, k) })
    segments.push({ wanted: [slice], previous: [previous[k]] })
    current = []
    shared = k
  }
  if (current.length > 0) segments.push({ wanted: current, previous: [] })
  return segments
}
