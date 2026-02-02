/**
 * Slice Selection Module
 * 
 * This module provides a function to select contiguous slices for rendering a 3D world
 * in a parallax engine. Slices are selected such that:
 * 1. They form contiguous z coverage with no gaps
 * 2. Smaller slices (more detail) are used for near viewing distances
 * 3. Larger slices (less detail) are used for far viewing distances
 * 4. Slice sizes are powers of 2 and aligned to their size boundaries
 * 5. Slices are defined in ABSOLUTE world coordinates (camera-independent)
 * 
 * The key insight is that slice boundaries are FIXED in world space,
 * not dependent on camera position. This ensures smooth movement in all directions.
 * The camera only determines WHICH slices are visible, not WHERE their boundaries are.
 */

export interface SliceBoundary {
  /** The starting z-coordinate in world space (absolute) */
  depth: number
  /** The thickness of this slice in z-units */
  size: number
}

/**
 * Determines the appropriate slice size for a given absolute z-coordinate.
 * Uses a logarithmic scale to assign larger slices to larger z values.
 * 
 * @param absoluteZ - Absolute z-coordinate in world space
 * @returns Power-of-2 size for the slice
 */
function getSliceSizeForAbsoluteZ(absoluteZ: number): number {
  const minSize = 1
  const maxSize = 64
  
  // Use absolute value to handle negative z coordinates
  const absZ = Math.abs(absoluteZ)
  
  if (absZ < 1) return minSize
  
  // Use log2 to determine the appropriate power of 2
  // This creates a progression: 1, 2, 4, 8, 16, 32, 64
  // Slices get larger as we move away from z=0
  const log2Z = Math.log2(absZ)
  const sizeExponent = Math.min(Math.floor(log2Z / 2), Math.log2(maxSize))
  
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
 * IMPORTANT: Slice boundaries are FIXED in absolute world coordinates.
 * The same z-coordinate will always be in the same slice, regardless of camera position.
 * The camera position only determines which slices are visible.
 * 
 * The algorithm:
 * 1. Convert relative viewing depths to absolute world z-coordinates
 * 2. For each position, determine slice size based on the ABSOLUTE z-coordinate
 * 3. Align slices to their size boundaries (in absolute coordinates)
 * 4. This ensures layer boundaries don't "jump" when camera moves
 * 
 * @param cameraZ - Camera z position (used to compute visible range)
 * @param minRelativeDepth - Minimum viewing depth (relative to camera)
 * @param maxRelativeDepth - Maximum viewing depth (relative to camera)
 * @returns Array of slice boundaries sorted by depth (in absolute world coordinates)
 */
export function selectSlices(cameraZ: number, minRelativeDepth: number, maxRelativeDepth: number): SliceBoundary[] {
  // Convert relative depths to absolute world z-coordinates
  const visibleMinZ = cameraZ + minRelativeDepth
  const visibleMaxZ = cameraZ + maxRelativeDepth
  
  if (visibleMinZ >= visibleMaxZ) {
    return []
  }

  const slices: SliceBoundary[] = []
  let currentZ = visibleMinZ
  
  // Use a Set to avoid duplicate slices at same depth
  const usedDepths = new Set<number>()

  while (currentZ < visibleMaxZ) {
    // Get appropriate size based on ABSOLUTE z-coordinate
    // This ensures consistent layer boundaries regardless of camera position
    let size = getSliceSizeForAbsoluteZ(currentZ)
    
    // Align the start position to the slice size boundary in ABSOLUTE world coordinates
    // This is the key: boundaries are fixed in world space
    let depth = alignToSize(currentZ, size)
    
    // If alignment moved us backward, we need to ensure we don't create gaps
    if (depth < currentZ) {
      // Find a smaller size that aligns correctly
      while (size > 1 && alignToSize(currentZ, size) < currentZ) {
        size = size / 2
      }
      depth = alignToSize(currentZ, size)
    }
    
    // Ensure we're making forward progress
    if (depth < currentZ) {
      size = 1
      depth = Math.floor(currentZ)
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
