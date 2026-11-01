/**
 * Slice selection: decides which slices of a face's layers (view.ts) the
 * camera renders, how they are split into chunks, and along which
 * direction each chunk is baked. Depths count layers, LAYER apart. A voxel
 * (a rhombic dodecahedron, fcc.ts) in layer c reaches from layer c − 1 to
 * c + 1, so a slice of `size` layers is size + 1 thick, and neighbouring
 * slices interlock.
 *
 * Constraints (see docs/architecture.md for the derivation and worked examples):
 *
 * 1. Occlusion (physical). A slice is drawn flat, so a thick slice can show
 *    geometry that true perspective hides. A slice at viewing distance d at
 *    most d / detail thick (size + 1 ≤ d / detail), with detail = leakFreeDetail(...), never shows
 *    more than `max leak` screen pixels of it. Far voxels are small on
 *    screen, so slices grow with distance and covering distance n takes
 *    O(detail · log n) slices.
 *
 * 2. Caching (NAPOT). Slice sizes are powers of two up to MAX_SIZE, and a
 *    slice of size N may only start at a depth z with z % N == 0. Sizes nest
 *    (every aligned slice splits into aligned halves), and a given
 *    (depth, size) slice always has the same content, so it can be cached.
 *
 * Walking away from the camera, each step takes the largest aligned slice
 * not thicker than the occlusion limit. Thinner is always allowed, so
 * alignment never breaks the occlusion bound.
 *
 * Slices are split in x and y into aligned chunks (chunkCell), and
 * each chunk is baked as a parallel projection along a direction from a
 * power-of-two grid (directionStep) close to the camera's view of it. The
 * smaller the angle between that direction and the actual rays, the
 * thicker slices may be.
 */
import { LAYER } from './view'

export interface SliceBoundary {
  /** First layer of the slice (absolute, camera-independent). */
  depth: number
  /** Number of layers: the slice holds voxels of layers [depth, depth + size), and reaches from depth − 1 to depth + size. */
  size: number
}

const MAX_SIZE = 64
/** C: a chunk spans at most C · size layer spacings across. */
const CHUNK_WIDTH_PER_SIZE = 16

/**
 * The aligned cells a slice of `size` is split into, in lattice units of
 * its face (view.ts): chunk (i, j) holds the voxels with a in
 * [i · columns, (i + 1) · columns) and b in [j · rows, (j + 1) · rows), and
 * draws [i · width, (i + 1) · width) × [j · height, (j + 1) · height) of the
 * plane, in face coordinates: 16 · size layer spacings (11.3 · size) by
 * 8 · size. A slice's thickness, (size + 1) layer spacings, is at most its
 * distance / detail, so a chunk spans at most C / detail radians on screen.
 */
export function chunkCell(size: number): { columns: number; rows: number; width: number; height: number } {
  const columns = CHUNK_WIDTH_PER_SIZE * size
  const rows = (CHUNK_WIDTH_PER_SIZE / 2) * size
  return { columns, rows, width: columns * LAYER, height: rows }
}

/**
 * How far gap filling may grow a face, as a tangent times the distance
 * from the slice's centre plane (MAX_REACH in bake/src/surface.rs).
 */
const MAX_REACH = 1

/**
 * How far around its cell a chunk of a slice of `size` may draw voxels
 * from, in lattice units: `columns` along a, `rows` along b (cell_margin in
 * bake/src/surface.rs). `rows` also bounds how far from a voxel's b its
 * faces may be drawn, with faces grown by at most MAX_REACH.
 */
export function cellMargin(size: number): { columns: number; rows: number } {
  const half = ((size + 1) / 2) * LAYER
  return { columns: Math.ceil(((1 + MAX_REACH) * half + 1.5) / LAYER), rows: Math.ceil((LAYER + MAX_REACH) * half + 1.5) }
}

/**
 * The largest angle error (as a tangent) between a ray and the direction its
 * chunk is baked along, given the focal length in pixels, the largest
 * tangent of a ray the slices are drawn for (1 for a face, see inFace) and the
 * leak tolerance ε in pixels.
 *
 * A slice [a, a + s] drawn at its centre misplaces an edge seen at tangent
 * τ_err off its baking direction by up to τ_err·s/2 world units; a leak
 * needs two such errors, so it is at most τ_err·s·focal/a pixels. With
 * s ≤ a / detail that is τ_err·focal/detail ≤ ε, so detail = τ_err·focal/ε.
 * Chunks span at most C / detail and directions are at most that far apart
 * (directionStep), so τ_err ≤ C / detail. Both hold for
 * τ_err = √(C·ε / focal). Rays are never more than maxTangent off a
 * straight-ahead bake, so τ_err is at most that.
 */
export function bakeAngleError(focal: number, maxTangent: number, maxLeakPixels: number): number {
  return Math.min(maxTangent, Math.sqrt((CHUNK_WIDTH_PER_SIZE * maxLeakPixels) / focal))
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
  return 2 ** Math.floor(Math.log2(CHUNK_WIDTH_PER_SIZE / detail))
}

/** The direction a chunk whose centre ray has `tangent` is baked along: the nearest multiple of `step`. */
export function nearestDirection(tangent: number, step: number): number {
  return Math.round(tangent / step) * step
}

/** z (face coordinates) of a slice's centre plane, the plane its chunks are baked onto and drawn at. */
export function sliceCentre({ depth, size }: SliceBoundary): number {
  return (depth + (size - 1) / 2) * LAYER
}

/** Largest power of two <= n, clamped to [1, MAX_SIZE]. */
function floorPowerOfTwo(n: number): number {
  if (n < 2) return 1
  return Math.min(2 ** Math.floor(Math.log2(n)), MAX_SIZE)
}

/**
 * The slice starting at `depth` with the smallest aligned size >= minSize,
 * or the largest aligned size if none is big enough.
 */
export function getSliceAtDepth(depth: number, minSize: number): SliceBoundary {
  const intDepth = Math.floor(depth)
  let size = 1
  while (size < minSize && size < MAX_SIZE && intDepth % (size * 2) === 0) size *= 2
  return { depth: intDepth, size }
}

/**
 * Contiguous slices covering layers from cameraZ + minRelativeDepth to
 * cameraZ + maxRelativeDepth, sorted near to far; all in layers. No slice
 * is thicker (size + 1) than max(2, a / detail), where a is the distance to
 * its near side (depth - 1, the near tips of its first layer's voxels).
 */
export function selectSlices(
  cameraZ: number,
  minRelativeDepth: number,
  maxRelativeDepth: number,
  detail: number,
): SliceBoundary[] {
  if (minRelativeDepth >= maxRelativeDepth) return []
  const farZ = cameraZ + maxRelativeDepth
  const slices: SliceBoundary[] = []
  // Round up: a slice closer than minRelativeDepth would be blown up over the screen.
  for (let z = Math.ceil(cameraZ + minRelativeDepth); z < farZ; ) {
    const slice = getSliceAtDepth(z, floorPowerOfTwo((z - 1 - cameraZ) / detail - 1))
    slices.push(slice)
    z = slice.depth + slice.size
  }
  return slices
}

/**
 * Pairs up two tilings of a face's layers (contiguous slices, near to far,
 * as selectSlices returns them): segments of consecutive `wanted` slices,
 * each with the `previous` slices holding exactly its layers (the first
 * may start nearer), split wherever both tilings have a boundary. Where
 * `previous` has no such slices, a segment gets none.
 */
export function matchTilings(wanted: SliceBoundary[], previous: SliceBoundary[]): { wanted: SliceBoundary[]; previous: SliceBoundary[] }[] {
  const starts = new Map(previous.map((s, k) => [s.depth, k]))
  const ends = new Map(previous.map((s, k) => [s.depth + s.size, k]))
  const segments: { wanted: SliceBoundary[]; previous: SliceBoundary[] }[] = []
  let current: SliceBoundary[] = []
  for (const slice of wanted) {
    current.push(slice)
    const end = ends.get(slice.depth + slice.size)
    if (end === undefined) continue
    const from = current[0].depth
    let start = starts.get(from)
    // The first segment may start within a previous slice.
    if (start === undefined && segments.length === 0) {
      const k = previous.findIndex(s => s.depth < from && from < s.depth + s.size)
      if (k >= 0) start = k
    }
    segments.push({ wanted: current, previous: start === undefined || start > end ? [] : previous.slice(start, end + 1) })
    current = []
  }
  if (current.length > 0) segments.push({ wanted: current, previous: [] })
  return segments
}
