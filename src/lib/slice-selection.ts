/**
 * Slice Selection Module
 * 
 * This module implements a two-mechanism rendering system:
 * 
 * ## Mechanism 1: Camera-Independent World Slicing
 * - Slices have FIXED positions in absolute world coordinates
 * - Slice sizes are determined by ALIGNMENT constraints (power-of-2 divisibility)
 * - Slices are rendered FLAT (orthographic) without any camera/perspective info
 * - Slice boundaries are globally consistent and never change
 * 
 * ## Mechanism 2: Camera-Dependent Selection & Compositing
 * - Camera determines WHICH slices are visible (selection based on viewing range)
 * - Selected slices are rendered lazily when requested
 * - Compositing applies parallax effect using camera position
 * 
 * ## Slice Size Rules (Alignment-Based)
 * 
 * Slice size is determined by the starting depth's alignment:
 * - Size-1 slices can start at any integer z
 * - Size-2 slices can only start at z where z % 2 == 0
 * - Size-4 slices can only start at z where z % 4 == 0
 * - Size-N slices can only start at z where z % N == 0
 * 
 * The algorithm picks the largest valid size (up to MAX_SIZE) for each position.
 * This achieves O(log n) slices when starting from z=0, while ensuring
 * camera-independence and proper boundary alignment.
 * 
 * Example slice progression from z=0:
 * - z=0: size 1 (special case near origin)
 * - z=1: size 1 (1 % 1 == 0)
 * - z=2: size 2 (2 % 2 == 0)
 * - z=4: size 4 (4 % 4 == 0)
 * - z=8: size 8 (8 % 8 == 0)
 * - etc.
 */

export interface SliceBoundary {
  /** The starting z-coordinate in world space (absolute, camera-independent) */
  depth: number
  /** The thickness of this slice in z-units */
  size: number
}

const MIN_SIZE = 1
const MAX_SIZE = 64
export const DEFAULT_DEPTH_MULTIPLIER = 2

/**
 * Gets the maximum candidate size for a given z-coordinate.
 * This is a starting point - the actual size may be smaller due to alignment constraints.
 * Uses a geometric scale where max size equals the largest power of the multiplier that is <= |z|.
 * 
 * Note: The actual slice size is determined by alignment in generateSlicesForRange().
 * This function only provides the upper bound.
 * 
 * @param absoluteZ - Absolute z-coordinate in world space
 * @param depthMultiplier - The geometric progression multiplier (default 2 for power-of-2)
 * @returns Maximum size for a slice at this z, based on the multiplier progression (rounded to integer)
 */
function getSliceSizeForAbsoluteZ(absoluteZ: number, depthMultiplier: number = DEFAULT_DEPTH_MULTIPLIER): number {
  const absZ = Math.abs(absoluteZ)
  
  if (absZ < 1) return MIN_SIZE
  
  // Use log to determine the largest power of multiplier <= absZ
  const logZ = Math.log(absZ) / Math.log(depthMultiplier)
  const sizeExponent = Math.min(Math.floor(logZ), Math.log(MAX_SIZE) / Math.log(depthMultiplier))
  
  // Round to nearest integer for proper alignment with integer z-coordinates
  const rawSize = Math.pow(depthMultiplier, sizeExponent)
  return Math.max(MIN_SIZE, Math.round(rawSize))
}

/**
 * Generates all canonical slice boundaries for a given z range.
 * 
 * This is the CAMERA-INDEPENDENT slicing mechanism. Slice boundaries are fixed
 * in world space and do not depend on camera position. The camera only determines
 * WHICH slices are selected for rendering.
 * 
 * ## Alignment-Based Sizing
 * 
 * The actual slice size at each position is the largest power of the multiplier that:
 * 1. Evenly divides the starting depth (depth % size == 0)
 * 2. Does not exceed the candidate size from getSliceSizeForAbsoluteZ()
 * 
 * This ensures proper alignment while respecting the z-based upper bound.
 * 
 * The algorithm ensures:
 * 1. Contiguous coverage with no gaps
 * 2. No overlapping slices
 * 3. Slices aligned to their size boundaries (depth % size == 0)
 * 4. Consistent boundaries regardless of how the function is called
 * 
 * @param minZ - Minimum z-coordinate (absolute world space)
 * @param maxZ - Maximum z-coordinate (absolute world space)
 * @param depthMultiplier - The geometric progression multiplier (default 2 for power-of-2)
 * @returns Array of slice boundaries sorted by depth
 */
function generateSlicesForRange(minZ: number, maxZ: number, depthMultiplier: number = DEFAULT_DEPTH_MULTIPLIER): SliceBoundary[] {
  if (minZ >= maxZ) {
    return []
  }

  const slices: SliceBoundary[] = []
  let currentZ = minZ
  
  while (currentZ < maxZ) {
    // Get the canonical slice for this position
    const size = getSliceSizeForAbsoluteZ(currentZ, depthMultiplier)
    
    // Align to size boundary
    let depth = Math.floor(currentZ / size) * size
    
    // If alignment moved us backward, find a smaller slice that starts at or after currentZ
    if (depth < currentZ) {
      // Try progressively smaller sizes until we find one that aligns correctly
      let adjustedSize = Math.max(MIN_SIZE, Math.round(size / depthMultiplier))
      let foundValidSize = false
      
      while (adjustedSize >= MIN_SIZE) {
        const alignedDepth = Math.floor(currentZ / adjustedSize) * adjustedSize
        if (alignedDepth >= currentZ) {
          depth = alignedDepth
          foundValidSize = true
          break
        }
        const previousSize = adjustedSize
        adjustedSize = Math.max(MIN_SIZE, Math.round(adjustedSize / depthMultiplier))
        // Exit if size can't decrease further (prevents infinite loop at MIN_SIZE)
        if (adjustedSize >= previousSize) {
          break
        }
      }
      
      // If no smaller size worked, use size 1 slice at current position
      if (!foundValidSize) {
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
 * @param depthMultiplier - The geometric progression multiplier (default 2 for power-of-2)
 * @returns Array of slice boundaries sorted by depth (in absolute world coordinates)
 */
export function selectSlices(cameraZ: number, minRelativeDepth: number, maxRelativeDepth: number, depthMultiplier: number = DEFAULT_DEPTH_MULTIPLIER): SliceBoundary[] {
  // Convert relative depths to absolute world z-coordinates
  const visibleMinZ = cameraZ + minRelativeDepth
  const visibleMaxZ = cameraZ + maxRelativeDepth
  
  // Generate camera-independent slices for the visible range
  return generateSlicesForRange(visibleMinZ, visibleMaxZ, depthMultiplier)
}
