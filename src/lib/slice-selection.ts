/**
 * Slice Selection Module
 * 
 * This module implements a two-mechanism rendering system:
 * 
 * ## Mechanism 1: World Slice Availability (Camera-Independent)
 * 
 * At any given z-coordinate, multiple slices of different sizes are AVAILABLE:
 * - A slice of size N can start at z if z % N == 0
 * - For z=0: slices of ALL sizes are available (1, 2, 4, 8, 16, 32, 64)
 * - For z=8: slices of size 1, 2, 4, 8 are available (since 8 % 8 == 0)
 * - For z=6: slices of size 1, 2 are available (since 6 % 2 == 0 but 6 % 4 != 0)
 * 
 * The world provides slices on request: "Give me a slice starting at Z with size >= N"
 * The world returns the SMALLEST valid slice that satisfies the constraint.
 * 
 * ## Mechanism 2: Camera Slice Selection (Camera-Dependent)
 * 
 * The camera requests slices based on viewing distance:
 * 1. Start at nearZ (camera + minRelativeDepth)
 * 2. Request a slice with minSize based on viewing distance (geometric progression)
 * 3. World provides a slice (possibly larger if alignment requires)
 * 4. Camera uses the ACTUAL slice size to compute next Z
 * 5. Camera uses geometric progression to compute next minSize
 * 6. Repeat until farZ is reached
 * 
 * This achieves:
 * - Thin slices near camera (more detail)
 * - Thick slices far from camera (efficiency)
 * - Slices always respect world alignment constraints
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

// ============================================================================
// MECHANISM 1: World Slice Availability (Camera-Independent)
// ============================================================================

/**
 * Builds the list of valid sizes for the given depth multiplier.
 * Valid sizes are powers of the multiplier (1, m, m^2, ...) up to MAX_SIZE.
 */
function getValidSizes(depthMultiplier: number): number[] {
  const sizes: number[] = []
  let testSize = MIN_SIZE
  while (testSize <= MAX_SIZE) {
    sizes.push(testSize)
    const nextSize = Math.round(testSize * depthMultiplier)
    if (nextSize <= testSize) break
    testSize = nextSize
  }
  return sizes
}

/**
 * Gets a slice starting at exactly the given depth with size >= minSize.
 * 
 * The world provides the SMALLEST valid slice that:
 * 1. Starts at exactly the given depth
 * 2. Has size >= minSize
 * 3. Respects alignment (depth % size == 0)
 * 
 * If no valid slice >= minSize exists at this depth, returns the largest
 * valid slice available at this depth.
 * 
 * @param depth - The exact starting z-coordinate (must be an integer)
 * @param minSize - Minimum requested slice size
 * @param depthMultiplier - The geometric progression multiplier (default 2)
 * @returns A slice starting at depth with the smallest valid size >= minSize
 */
export function getSliceAtDepth(depth: number, minSize: number, depthMultiplier: number = DEFAULT_DEPTH_MULTIPLIER): SliceBoundary {
  const intDepth = Math.floor(depth)
  const validSizes = getValidSizes(depthMultiplier)
  
  // Find all sizes that are valid at this depth (depth % size == 0)
  // For depth 0, all sizes are valid
  const validAtDepth = validSizes.filter(size => intDepth === 0 || intDepth % size === 0)
  
  if (validAtDepth.length === 0) {
    // Fallback: size 1 is always valid
    return { depth: intDepth, size: MIN_SIZE }
  }
  
  // Find the smallest size >= minSize
  const satisfying = validAtDepth.filter(size => size >= minSize)
  
  if (satisfying.length > 0) {
    // Return the smallest size that satisfies the constraint
    return { depth: intDepth, size: Math.min(...satisfying) }
  } else {
    // No size >= minSize is valid at this depth
    // Return the largest valid size available
    return { depth: intDepth, size: Math.max(...validAtDepth) }
  }
}

// ============================================================================
// MECHANISM 2: Camera Slice Selection (Camera-Dependent)
// ============================================================================

/**
 * Computes the minimum slice size requested by camera based on viewing distance.
 * 
 * Uses geometric progression: minSize = depthMultiplier ^ floor(log_m(viewingDistance))
 * This means:
 * - viewingDistance 1-2: minSize 1
 * - viewingDistance 2-4: minSize 2
 * - viewingDistance 4-8: minSize 4
 * - etc.
 * 
 * @param viewingDistance - Distance from camera to slice start
 * @param depthMultiplier - The geometric progression multiplier (default 2)
 * @returns Minimum slice size to request from the world
 */
function getMinSizeForViewingDistance(viewingDistance: number, depthMultiplier: number = DEFAULT_DEPTH_MULTIPLIER): number {
  if (viewingDistance < 1) return MIN_SIZE
  
  // minSize = largest power of depthMultiplier <= viewingDistance
  const logDist = Math.log(viewingDistance) / Math.log(depthMultiplier)
  const exponent = Math.floor(logDist)
  const size = Math.round(Math.pow(depthMultiplier, exponent))
  
  return Math.min(Math.max(size, MIN_SIZE), MAX_SIZE)
}

/**
 * Selects slices visible from the camera's perspective.
 * 
 * This is the main CAMERA SELECTION function:
 * 1. Start at nearZ (camera + minRelativeDepth)
 * 2. Compute minSize based on viewing distance
 * 3. Request slice from world: "give me slice at Z with size >= minSize"
 * 4. World provides slice (possibly larger due to alignment)
 * 5. Use ACTUAL slice size to compute next Z
 * 6. Repeat until farZ is reached
 * 
 * @param cameraZ - Camera z position in world space
 * @param minRelativeDepth - Minimum viewing depth (relative to camera, typically 1)
 * @param maxRelativeDepth - Maximum viewing depth (relative to camera)
 * @param depthMultiplier - The geometric progression multiplier (default 2)
 * @returns Array of slice boundaries sorted by depth (in absolute world coordinates)
 */
export function selectSlices(cameraZ: number, minRelativeDepth: number, maxRelativeDepth: number, depthMultiplier: number = DEFAULT_DEPTH_MULTIPLIER): SliceBoundary[] {
  // Convert relative depths to absolute world z-coordinates
  const nearZ = cameraZ + minRelativeDepth
  const farZ = cameraZ + maxRelativeDepth
  
  if (nearZ >= farZ) {
    return []
  }

  const slices: SliceBoundary[] = []
  let currentZ = Math.floor(nearZ)
  
  while (currentZ < farZ) {
    // Compute viewing distance from camera
    const viewingDistance = currentZ - cameraZ
    
    // Camera requests: "give me slice with size >= minSize"
    const minSize = getMinSizeForViewingDistance(viewingDistance, depthMultiplier)
    
    // World provides: smallest valid slice >= minSize at this depth
    const slice = getSliceAtDepth(currentZ, minSize, depthMultiplier)
    
    slices.push(slice)
    
    // Move to next slice using ACTUAL slice size
    const nextZ = slice.depth + slice.size
    
    // Safety check to prevent infinite loops
    if (nextZ <= currentZ) {
      currentZ = currentZ + 1
    } else {
      currentZ = nextZ
    }
  }

  return slices.sort((a, b) => a.depth - b.depth)
}
