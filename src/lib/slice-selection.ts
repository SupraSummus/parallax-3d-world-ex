/**
 * Slice Selection Module
 * 
 * This module provides a function to select contiguous slices for rendering a 3D world
 * in a parallax engine. Slices are selected such that:
 * 1. They form contiguous z coverage with no gaps
 * 2. Smaller slices (more detail) are used near the camera
 * 3. Larger slices (less detail) are used far from the camera
 * 4. Slice sizes are powers of 2 and aligned to their size boundaries
 */

export interface SliceBoundary {
  depth: number
  size: number
}

/**
 * Determines the appropriate slice size for a given distance from camera.
 * Uses a logarithmic scale to assign larger slices to farther distances.
 * 
 * @param distance - Distance from camera to the slice start
 * @returns Power-of-2 size for the slice
 */
function getSliceSizeForDistance(distance: number): number {
  const minSize = 1
  const maxSize = 64
  
  if (distance <= 0) return minSize
  
  // Use log2 to determine the appropriate power of 2
  // This creates a progression: 1, 2, 4, 8, 16, 32, 64
  // for increasing distances
  const log2Distance = Math.log2(distance)
  const sizeExponent = Math.min(Math.floor(log2Distance / 2), Math.log2(maxSize))
  
  return Math.max(minSize, Math.pow(2, sizeExponent))
}

/**
 * Rounds a position down to the nearest boundary aligned to the given size.
 * 
 * @param z - Position to round
 * @param size - Size to align to
 * @returns Aligned position
 */
function alignToSize(z: number, size: number): number {
  return Math.floor(z / size) * size
}

/**
 * Selects slices that cover a z range with contiguous coverage.
 * 
 * The algorithm works by:
 * 1. Starting at the minimum z value
 * 2. For each position, determining the appropriate slice size based on distance from camera
 * 3. Aligning the slice to its size boundary
 * 4. Adding the slice and moving to the next position (end of current slice)
 * 5. Continuing until the maximum z value is covered
 * 
 * @param cameraZ - Camera z position (used to determine slice sizes)
 * @param minZ - Minimum z value to cover (slices start from here)
 * @param maxZ - Maximum z value to cover (slices extend until covering this)
 * @returns Array of slice boundaries sorted by depth
 */
export function selectSlices(cameraZ: number, minZ: number, maxZ: number): SliceBoundary[] {
  if (minZ >= maxZ) {
    return []
  }

  const slices: SliceBoundary[] = []
  let currentZ = minZ
  
  // Use a Set to avoid duplicate slices at same depth
  const usedDepths = new Set<number>()

  while (currentZ < maxZ) {
    // Calculate distance from camera to determine slice size
    const distanceFromCamera = currentZ - cameraZ
    
    // Get appropriate size for this distance
    let size = getSliceSizeForDistance(Math.abs(distanceFromCamera))
    
    // Align the start position to the slice size boundary
    let depth = alignToSize(currentZ, size)
    
    // If alignment moved us backward, we need to ensure we don't create gaps
    // In this case, the current position might need a smaller slice
    if (depth < currentZ) {
      // Find the largest size that starts at currentZ aligned position
      // or use a smaller size that fits
      while (size > 1 && alignToSize(currentZ, size) < currentZ) {
        size = size / 2
      }
      depth = alignToSize(currentZ, size)
    }
    
    // Ensure we're making forward progress
    if (depth < currentZ) {
      // If we still can't align properly, use size 1 starting at currentZ
      size = 1
      depth = currentZ
    }
    
    // Only add if this depth hasn't been used
    if (!usedDepths.has(depth)) {
      slices.push({ depth, size })
      usedDepths.add(depth)
    }
    
    // Move to the end of this slice
    currentZ = depth + size
  }

  return slices.sort((a, b) => a.depth - b.depth)
}
