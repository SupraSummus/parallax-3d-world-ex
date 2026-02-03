/**
 * Slice Selection Module
 * 
 * This module provides a function to select contiguous slices for rendering a 3D world
 * in a parallax engine. Slices are selected such that:
 * 1. They form contiguous z coverage with no gaps
 * 2. Smaller slices (more detail) are used for near viewing distances
 * 3. Larger slices (less detail) are used for far viewing distances
 * 4. Slice sizes are powers of 2 based on viewing distance from camera
 * 5. **O(log n) slices are used to cover distance n** - geometric progression ensures
 *    that each slice doubles in size, so covering distance n requires only ~log2(n) slices
 * 
 * The key insight is that slice sizes are based on VIEWING DISTANCE (distance from camera),
 * which creates proper geometric progression where nearby things have more detail.
 * 
 * The geometric progression works as follows (for camera at z=0):
 * - Viewing distance 1 → size 1 (covers 1-2)
 * - Viewing distance 2 → size 2 (covers 2-4)
 * - Viewing distance 4 → size 4 (covers 4-8)
 * - Viewing distance 8 → size 8 (covers 8-16)
 * - etc.
 * 
 * This is bounded by a maxSize (currently 64) to prevent extremely large slices.
 */

export interface SliceBoundary {
  /** The starting z-coordinate in world space (absolute) */
  depth: number
  /** The thickness of this slice in z-units */
  size: number
}

/**
 * Determines the appropriate slice size for a given viewing distance.
 * Uses a geometric scale where slice size equals the largest power of 2 that is <= viewingDistance.
 * 
 * This achieves O(log n) slices for distance n because:
 * - Viewing distance 1 → size 1 (covers 1-2)
 * - Viewing distance 2 → size 2 (covers 2-4)
 * - Viewing distance 4 → size 4 (covers 4-8)
 * - Viewing distance 8 → size 8 (covers 8-16)
 * - etc.
 * 
 * Each slice doubles in size and covers double the distance, creating a geometric series.
 * 
 * @param viewingDistance - Distance from camera to the slice
 * @returns Power-of-2 size for the slice
 */
export function getSliceSizeForViewingDistance(viewingDistance: number): number {
  const minSize = 1
  const maxSize = 64
  
  if (viewingDistance < 1) return minSize
  
  // Use log2 to determine the largest power of 2 <= viewingDistance
  // This gives geometric progression: size = 2^floor(log2(viewingDistance))
  // Achieving O(log n) slices for distance n
  const log2Dist = Math.log2(viewingDistance)
  const sizeExponent = Math.min(Math.floor(log2Dist), Math.log2(maxSize))
  
  return Math.max(minSize, Math.pow(2, sizeExponent))
}

/**
 * Selects slices that cover a z range with contiguous coverage.
 * 
 * The algorithm uses a simple geometric progression based on viewing distance:
 * - Start at the minimum viewing depth (closest to camera)
 * - Calculate slice size based on the current viewing distance
 * - Each slice starts where the previous one ends (contiguous coverage)
 * - Slice sizes follow geometric progression: 1, 2, 4, 8, 16, 32, 64...
 * 
 * @param cameraZ - Camera z position (used to compute visible range)
 * @param minRelativeDepth - Minimum viewing depth (relative to camera), must be >= 1
 * @param maxRelativeDepth - Maximum viewing depth (relative to camera)
 * @returns Array of slice boundaries sorted by depth (in absolute world coordinates)
 */
export function selectSlices(cameraZ: number, minRelativeDepth: number, maxRelativeDepth: number): SliceBoundary[] {
  if (minRelativeDepth >= maxRelativeDepth) {
    return []
  }

  const slices: SliceBoundary[] = []
  
  // Start at the minimum viewing distance
  let currentViewingDistance = Math.max(1, minRelativeDepth)
  
  while (currentViewingDistance < maxRelativeDepth) {
    // Calculate slice size based on current viewing distance
    const size = getSliceSizeForViewingDistance(currentViewingDistance)
    
    // Convert viewing distance to absolute world z-coordinate
    const depth = cameraZ + currentViewingDistance
    
    slices.push({ depth, size })
    
    // Move to the next slice (contiguous coverage)
    currentViewingDistance += size
  }

  return slices
}
