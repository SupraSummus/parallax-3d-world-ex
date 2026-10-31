/**
 * Slice selection: decides which z-slices of the world the camera renders.
 *
 * Two mechanisms (see DESIGN.md for worked examples):
 *
 * 1. World slice availability (camera-independent). Valid slice sizes form a
 *    geometric progression 1, m, m², ... (rounded, capped at MAX_SIZE). A
 *    slice of size N may only start at a depth z with z % N == 0, so a given
 *    (depth, size) slice always has the same content and can be cached.
 *
 * 2. Camera selection (camera-dependent). Walking away from the camera, each
 *    step requests a slice whose size grows with viewing distance; the world
 *    returns the smallest aligned size satisfying the request. The result is
 *    contiguous coverage with ~log(n) slices: thin near the camera, thick far
 *    away.
 */

export interface SliceBoundary {
  /** Starting z in world space (absolute, camera-independent). */
  depth: number
  /** Thickness in z units. */
  size: number
}

const MAX_SIZE = 64
export const DEFAULT_DEPTH_MULTIPLIER = 2
export const MIN_DEPTH_MULTIPLIER = 1.2
export const MAX_DEPTH_MULTIPLIER = 4

export function clampDepthMultiplier(multiplier: number): number {
  return Math.min(MAX_DEPTH_MULTIPLIER, Math.max(MIN_DEPTH_MULTIPLIER, multiplier))
}

/** Slice sizes 1, m, m², ... up to MAX_SIZE, rounded; stops if rounding stops growth. */
function getValidSizes(depthMultiplier: number): number[] {
  const sizes: number[] = []
  for (let size = 1; size <= MAX_SIZE; ) {
    sizes.push(size)
    const next = Math.round(size * depthMultiplier)
    if (next <= size) break
    size = next
  }
  return sizes
}

/**
 * Mechanism 1: the slice starting at `depth` with the smallest aligned size
 * >= minSize, or the largest aligned size if none is big enough.
 */
export function getSliceAtDepth(
  depth: number,
  minSize: number,
  depthMultiplier: number = DEFAULT_DEPTH_MULTIPLIER,
): SliceBoundary {
  const intDepth = Math.floor(depth)
  // Size 1 is always aligned, so this is never empty.
  const aligned = getValidSizes(depthMultiplier).filter(size => intDepth % size === 0)
  const size = aligned.find(s => s >= minSize) ?? aligned[aligned.length - 1]
  return { depth: intDepth, size }
}

/** Largest power of the multiplier <= viewingDistance, clamped to [1, MAX_SIZE]. */
function getMinSizeForViewingDistance(viewingDistance: number, depthMultiplier: number): number {
  if (viewingDistance < 1) return 1
  const exponent = Math.floor(Math.log(viewingDistance) / Math.log(depthMultiplier))
  return Math.min(Math.max(Math.round(depthMultiplier ** exponent), 1), MAX_SIZE)
}

/**
 * Mechanism 2: contiguous slices covering world z from
 * cameraZ + minRelativeDepth to cameraZ + maxRelativeDepth, sorted near to far.
 */
export function selectSlices(
  cameraZ: number,
  minRelativeDepth: number,
  maxRelativeDepth: number,
  depthMultiplier: number = DEFAULT_DEPTH_MULTIPLIER,
): SliceBoundary[] {
  if (minRelativeDepth >= maxRelativeDepth) return []
  const farZ = cameraZ + maxRelativeDepth
  const slices: SliceBoundary[] = []
  for (let z = Math.floor(cameraZ + minRelativeDepth); z < farZ; ) {
    const minSize = getMinSizeForViewingDistance(z - cameraZ, depthMultiplier)
    const slice = getSliceAtDepth(z, minSize, depthMultiplier)
    slices.push(slice)
    z = slice.depth + slice.size
  }
  return slices
}
