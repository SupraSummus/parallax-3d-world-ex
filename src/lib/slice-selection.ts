/**
 * Slice selection: decides which z-slices of the world the camera renders.
 *
 * Two mechanisms (see DESIGN.md for worked examples):
 *
 * 1. World slice availability (camera-independent). Slice sizes are powers of
 *    two up to MAX_SIZE, and a slice of size N may only start at a depth z
 *    with z % N == 0. Sizes nest (every aligned slice splits into aligned
 *    halves), and a given (depth, size) slice always has the same content, so
 *    it can be cached.
 *
 * 2. Camera selection (camera-dependent). Walking away from the camera, each
 *    step requests a slice about (viewing distance / detail) thick; the world
 *    returns the smallest aligned size satisfying the request. The result is
 *    contiguous coverage with O(detail · log n) slices: thin near the camera,
 *    thick far away.
 */

export interface SliceBoundary {
  /** Starting z in world space (absolute, camera-independent). */
  depth: number
  /** Thickness in z units. */
  size: number
}

const MAX_SIZE = 64

/**
 * Detail is the ratio of viewing distance to requested slice thickness.
 * Higher detail means thinner slices (less perspective error inside each
 * slice) and more of them.
 */
export const DEFAULT_DETAIL = 4
export const MIN_DETAIL = 1
export const MAX_DETAIL = 16

export function clampDetail(detail: number): number {
  return Math.min(MAX_DETAIL, Math.max(MIN_DETAIL, detail))
}

/** Largest power of two <= n, clamped to [1, MAX_SIZE]. */
function floorPowerOfTwo(n: number): number {
  if (n < 2) return 1
  return Math.min(2 ** Math.floor(Math.log2(n)), MAX_SIZE)
}

/**
 * Mechanism 1: the slice starting at `depth` with the smallest aligned size
 * >= minSize, or the largest aligned size if none is big enough.
 */
export function getSliceAtDepth(depth: number, minSize: number): SliceBoundary {
  const intDepth = Math.floor(depth)
  let size = 1
  while (size < minSize && size < MAX_SIZE && intDepth % (size * 2) === 0) size *= 2
  return { depth: intDepth, size }
}

/**
 * Mechanism 2: contiguous slices covering world z from
 * cameraZ + minRelativeDepth to cameraZ + maxRelativeDepth, sorted near to far.
 */
export function selectSlices(
  cameraZ: number,
  minRelativeDepth: number,
  maxRelativeDepth: number,
  detail: number = DEFAULT_DETAIL,
): SliceBoundary[] {
  if (minRelativeDepth >= maxRelativeDepth) return []
  const farZ = cameraZ + maxRelativeDepth
  const slices: SliceBoundary[] = []
  for (let z = Math.floor(cameraZ + minRelativeDepth); z < farZ; ) {
    const slice = getSliceAtDepth(z, floorPowerOfTwo((z - cameraZ) / detail))
    slices.push(slice)
    z = slice.depth + slice.size
  }
  return slices
}
