/**
 * Slice selection: decides which z-slices of the world the camera renders.
 *
 * Two constraints (see DESIGN.md for the derivation and worked examples):
 *
 * 1. Occlusion (physical). A slice is drawn flat, so a thick slice can show
 *    geometry that true perspective hides. A slice at viewing distance d at
 *    most d / detail thick, with detail = leakFreeDetail(screen size, max
 *    leak), never shows more than `max leak` screen pixels of it. Far
 *    voxels are small on screen, so slices grow with distance and covering
 *    distance n takes O(detail · log n) slices.
 *
 * 2. Caching (NAPOT). Slice sizes are powers of two up to MAX_SIZE, and a
 *    slice of size N may only start at a depth z with z % N == 0. Sizes nest
 *    (every aligned slice splits into aligned halves), and a given
 *    (depth, size) slice always has the same content, so it can be cached.
 *
 * Walking away from the camera, each step takes the largest aligned slice
 * not thicker than the occlusion limit. Thinner is always allowed, so
 * alignment never breaks the occlusion bound.
 */

export interface SliceBoundary {
  /** Starting z in world space (absolute, camera-independent). */
  depth: number
  /** Thickness in z units. */
  size: number
}

const MAX_SIZE = 64

/**
 * Detail (viewing distance / maximum slice thickness) that keeps occlusion
 * leaks at most `maxLeakPixels` on a screen whose longer side is
 * `screenSize` pixels.
 *
 * A slice [a, a + s) drawn at its centre misplaces an edge seen at tangent τ
 * by up to τ·s/2 world units; a leak needs two such errors, so it is at most
 * τ·s units wide at depth ≥ a, i.e. τ·s·focal/a pixels. On screen
 * τ·focal ≤ screenSize/2, whatever the field of view, so
 * s ≤ 2 · maxLeakPixels · a / screenSize suffices.
 *
 * Rounded up to a quarter octave (denser slices are always safe), so small
 * resizes keep the slicing and the cache.
 */
export function leakFreeDetail(screenSize: number, maxLeakPixels: number): number {
  const detail = screenSize / (2 * maxLeakPixels)
  return detail <= 1 ? 1 : 2 ** (Math.ceil(4 * Math.log2(detail)) / 4)
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
 * Contiguous slices covering world z from cameraZ + minRelativeDepth to
 * cameraZ + maxRelativeDepth, sorted near to far. No slice is thicker than
 * max(1, its distance from the camera / detail).
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
  for (let z = Math.floor(cameraZ + minRelativeDepth); z < farZ; ) {
    const slice = getSliceAtDepth(z, floorPowerOfTwo((z - cameraZ) / detail))
    slices.push(slice)
    z = slice.depth + slice.size
  }
  return slices
}
