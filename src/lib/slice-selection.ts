/**
 * Slice Selection Module
 * 
 * This module implements a two-mechanism rendering system:
 * 
 * ## Mechanism 1: Camera-Independent World Slicing
 * - Slices have FIXED positions in absolute world coordinates
 * - Slice sizes are determined by absolute z-coordinate (geometric progression)
 * - Slices are rendered FLAT (orthographic) without any camera/perspective info
 * - Slice boundaries are globally consistent and never change
 * 
 * ## Mechanism 2: Camera-Dependent Selection & Compositing
 * - Camera determines WHICH slices are visible (selection based on viewing range)
 * - Selected slices are rendered lazily when requested
 * - Compositing applies parallax effect using camera position
 * 
 * The geometric progression for ABSOLUTE z-coordinates:
 * - z ∈ [1, 2): size 1
 * - z ∈ [2, 4): size 2
 * - z ∈ [4, 8): size 4
 * - z ∈ [8, 16): size 8
 * - etc.
 * 
 * This achieves O(log n) slices for distance n while maintaining camera-independence.
 */

export interface SliceBoundary {
  /** The starting z-coordinate in world space (absolute, camera-independent) */
  depth: number
  /** The thickness of this slice in z-units */
  size: number
}

const MIN_SIZE = 1
const MAX_SIZE = 64

/**
 * Determines the appropriate slice size for a given absolute z-coordinate.
 * Uses a geometric scale where slice size equals the largest power of 2 that is <= |z|.
 * 
 * This is CAMERA-INDEPENDENT - the same z-coordinate always produces the same size.
 * 
 * @param absoluteZ - Absolute z-coordinate in world space
 * @returns Power-of-2 size for the slice (1, 2, 4, 8, 16, 32, or 64)
 */
export function getSliceSizeForAbsoluteZ(absoluteZ: number): number {
  const absZ = Math.abs(absoluteZ)
  
  if (absZ < 1) return MIN_SIZE
  
  // Use log2 to determine the largest power of 2 <= absZ
  const log2Z = Math.log2(absZ)
  const sizeExponent = Math.min(Math.floor(log2Z), Math.log2(MAX_SIZE))
  
  return Math.max(MIN_SIZE, Math.pow(2, sizeExponent))
}

/**
 * Generates the canonical slice boundary for a given z-coordinate.
 * Returns the slice that CONTAINS this z-coordinate.
 * 
 * Slices are aligned to their size boundaries in world space.
 * For example:
 * - Size-1 slices start at ..., -2, -1, 0, 1, 2, ...
 * - Size-2 slices start at ..., -4, -2, 0, 2, 4, ...
 * - Size-4 slices start at ..., -8, -4, 0, 4, 8, ...
 * - etc.
 * 
 * @param z - Absolute z-coordinate in world space
 * @returns The slice boundary that contains this z-coordinate
 */
export function getSliceContainingZ(z: number): SliceBoundary {
  const size = getSliceSizeForAbsoluteZ(z)
  const depth = Math.floor(z / size) * size
  return { depth, size }
}

/**
 * Generates all canonical slice boundaries for a given z range.
 * 
 * This is the CAMERA-INDEPENDENT slicing mechanism. Slice boundaries are fixed
 * in world space and do not depend on camera position. The camera only determines
 * WHICH slices are selected for rendering.
 * 
 * The algorithm ensures:
 * 1. Contiguous coverage with no gaps
 * 2. No overlapping slices
 * 3. Slices aligned to their size boundaries
 * 4. Consistent boundaries regardless of how the function is called
 * 
 * @param minZ - Minimum z-coordinate (absolute world space)
 * @param maxZ - Maximum z-coordinate (absolute world space)
 * @returns Array of slice boundaries sorted by depth
 */
export function generateSlicesForRange(minZ: number, maxZ: number): SliceBoundary[] {
  if (minZ >= maxZ) {
    return []
  }

  const slices: SliceBoundary[] = []
  let currentZ = minZ
  
  while (currentZ < maxZ) {
    // Get the canonical slice for this position
    const size = getSliceSizeForAbsoluteZ(currentZ)
    
    // Align to size boundary
    let depth = Math.floor(currentZ / size) * size
    
    // If alignment moved us backward, use the next aligned position
    if (depth < currentZ) {
      // Check if we can fit a smaller slice that starts at currentZ
      let adjustedSize = size
      while (adjustedSize > MIN_SIZE) {
        const nextSize = adjustedSize / 2
        const nextDepth = Math.floor(currentZ / nextSize) * nextSize
        if (nextDepth >= currentZ) {
          adjustedSize = nextSize
          depth = nextDepth
          break
        }
        adjustedSize = nextSize
      }
      
      // If still behind, use size 1 slice at current position
      if (depth < currentZ) {
        depth = Math.floor(currentZ)
        adjustedSize = MIN_SIZE
      }
      
      slices.push({ depth, size: adjustedSize })
      currentZ = depth + adjustedSize
    } else {
      slices.push({ depth, size })
      currentZ = depth + size
    }
  }

  return slices.sort((a, b) => a.depth - b.depth)
}

/**
 * Selects slices that are visible from the camera's perspective.
 * 
 * This is the CAMERA-DEPENDENT selection mechanism:
 * 1. Computes the visible range in absolute world coordinates
 * 2. Selects slices from the canonical world slicing that overlap with visible range
 * 
 * The slices themselves are camera-independent (fixed world positions).
 * Only the SELECTION depends on camera position.
 * 
 * @param cameraZ - Camera z position in world space
 * @param minRelativeDepth - Minimum viewing depth (relative to camera)
 * @param maxRelativeDepth - Maximum viewing depth (relative to camera)
 * @returns Array of slice boundaries sorted by depth (in absolute world coordinates)
 */
export function selectSlices(cameraZ: number, minRelativeDepth: number, maxRelativeDepth: number): SliceBoundary[] {
  // Convert relative depths to absolute world z-coordinates
  const visibleMinZ = cameraZ + minRelativeDepth
  const visibleMaxZ = cameraZ + maxRelativeDepth
  
  // Generate camera-independent slices for the visible range
  return generateSlicesForRange(visibleMinZ, visibleMaxZ)
}
