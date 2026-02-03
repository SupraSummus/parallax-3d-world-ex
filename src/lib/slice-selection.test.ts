import { describe, it, expect } from 'vitest'
import { selectSlices, generateSlicesForRange, getSliceSizeForAbsoluteZ, getSliceContainingZ } from './slice-selection'

describe('Slice Selection', () => {
  describe('Mechanism 1: Camera-Independent Slicing', () => {
    describe('getSliceSizeForAbsoluteZ', () => {
      it('should return power-of-2 sizes based on absolute z', () => {
        expect(getSliceSizeForAbsoluteZ(0)).toBe(1)
        expect(getSliceSizeForAbsoluteZ(1)).toBe(1)
        expect(getSliceSizeForAbsoluteZ(2)).toBe(2)
        expect(getSliceSizeForAbsoluteZ(3)).toBe(2)
        expect(getSliceSizeForAbsoluteZ(4)).toBe(4)
        expect(getSliceSizeForAbsoluteZ(7)).toBe(4)
        expect(getSliceSizeForAbsoluteZ(8)).toBe(8)
        expect(getSliceSizeForAbsoluteZ(15)).toBe(8)
        expect(getSliceSizeForAbsoluteZ(16)).toBe(16)
        expect(getSliceSizeForAbsoluteZ(64)).toBe(64)
        expect(getSliceSizeForAbsoluteZ(128)).toBe(64) // Capped at 64
      })

      it('should handle negative z-coordinates', () => {
        expect(getSliceSizeForAbsoluteZ(-1)).toBe(1)
        expect(getSliceSizeForAbsoluteZ(-2)).toBe(2)
        expect(getSliceSizeForAbsoluteZ(-8)).toBe(8)
        expect(getSliceSizeForAbsoluteZ(-100)).toBe(64)
      })
    })

    describe('getSliceContainingZ', () => {
      it('should return slice aligned to size boundary', () => {
        const slice = getSliceContainingZ(10)
        expect(slice.depth).toBe(8)  // Aligned to size-8 boundary
        expect(slice.size).toBe(8)
      })

      it('should return consistent boundaries for same z', () => {
        const slice1 = getSliceContainingZ(10)
        const slice2 = getSliceContainingZ(10)
        expect(slice1).toEqual(slice2)
      })
    })

    describe('generateSlicesForRange', () => {
      it('should produce contiguous z coverage with no gaps', () => {
        const slices = generateSlicesForRange(0, 200)
        
        for (let i = 0; i < slices.length - 1; i++) {
          const currentEnd = slices[i].depth + slices[i].size
          const nextStart = slices[i + 1].depth
          expect(currentEnd).toBe(nextStart)
        }
      })

      it('should produce same slices for same range (camera-independent)', () => {
        const slices1 = generateSlicesForRange(0, 100)
        const slices2 = generateSlicesForRange(0, 100)
        expect(slices1).toEqual(slices2)
      })

      it('should use power-of-2 sizes', () => {
        const slices = generateSlicesForRange(0, 200)
        const validSizes = [1, 2, 4, 8, 16, 32, 64]
        
        slices.forEach(slice => {
          expect(validSizes).toContain(slice.size)
        })
      })
    })
  })

  describe('Mechanism 2: Camera-Dependent Selection', () => {
    describe('selectSlices', () => {
      it('should select slices based on camera position', () => {
        const slices = selectSlices(-30, 1, 100)
        
        // First slice should be at camera + minRelativeDepth
        expect(slices[0].depth).toBeGreaterThanOrEqual(-29)
        expect(slices[0].depth).toBeLessThanOrEqual(-29)
      })

      it('should produce contiguous coverage', () => {
        const slices = selectSlices(-30, 1, 200)
        
        for (let i = 0; i < slices.length - 1; i++) {
          const currentEnd = slices[i].depth + slices[i].size
          const nextStart = slices[i + 1].depth
          expect(currentEnd).toBe(nextStart)
        }
      })

      it('should maintain fixed world boundaries regardless of camera position', () => {
        // The same world z-coordinate should be in the same slice regardless of camera
        const cameraPositions = [-50, -30, 0, 20]
        const targetZ = 10  // Check z=10
        
        const slicesContainingTarget = cameraPositions
          .map(cameraZ => {
            const slices = selectSlices(cameraZ, 1, 100)
            // Only check if z=10 is in visible range
            const minVisibleZ = cameraZ + 1
            const maxVisibleZ = cameraZ + 100
            if (targetZ >= minVisibleZ && targetZ < maxVisibleZ) {
              return slices.find(s => s.depth <= targetZ && s.depth + s.size > targetZ)
            }
            return null
          })
          .filter(s => s !== null)
        
        // All should have same depth and size
        if (slicesContainingTarget.length > 1) {
          const first = slicesContainingTarget[0]
          slicesContainingTarget.forEach(slice => {
            expect(slice!.depth).toBe(first!.depth)
            expect(slice!.size).toBe(first!.size)
          })
        }
      })
    })
  })

  describe('Contiguous z coverage', () => {
    it('should produce contiguous z coverage with no gaps', () => {
      const slices = selectSlices(0, 1, 200)
      
      // Verify slices are sorted by depth
      const sorted = [...slices].sort((a, b) => a.depth - b.depth)
      expect(slices).toEqual(sorted)
      
      // Verify no gaps between consecutive slices
      for (let i = 0; i < slices.length - 1; i++) {
        const currentEnd = slices[i].depth + slices[i].size
        const nextStart = slices[i + 1].depth
        expect(currentEnd).toBe(nextStart)
      }
    })

    it('should cover the entire range from minZ to maxZ', () => {
      const minZ = 1
      const maxZ = 200
      const slices = selectSlices(0, minZ, maxZ)
      
      if (slices.length === 0) return
      
      // First slice should start at or before minZ
      expect(slices[0].depth).toBeLessThanOrEqual(minZ)
      
      // Last slice should end at or after maxZ  
      const lastSlice = slices[slices.length - 1]
      expect(lastSlice.depth + lastSlice.size).toBeGreaterThanOrEqual(maxZ)
    })

    it('should have no overlapping slices', () => {
      const slices = selectSlices(0, 1, 200)
      
      for (let i = 0; i < slices.length - 1; i++) {
        const currentEnd = slices[i].depth + slices[i].size
        const nextStart = slices[i + 1].depth
        expect(currentEnd).toBeLessThanOrEqual(nextStart)
      }
    })
  })

  describe('Slice sizes', () => {
    it('should use power-of-2 sizes', () => {
      const slices = selectSlices(0, 1, 200)
      const validSizes = [1, 2, 4, 8, 16, 32, 64, 128, 256]
      
      slices.forEach(slice => {
        expect(validSizes).toContain(slice.size)
      })
    })

    it('should use absolute z for size calculation (camera-independent)', () => {
      const slices = selectSlices(0, 1, 200)
      
      // Each slice's size should match the geometric progression based on ABSOLUTE z
      slices.forEach(slice => {
        const absZ = Math.abs(slice.depth)
        // Size should be largest power of 2 <= abs(z), capped at 64
        if (absZ >= 1) {
          const expectedMaxSize = Math.min(64, Math.pow(2, Math.floor(Math.log2(absZ))))
          expect(slice.size).toBeLessThanOrEqual(expectedMaxSize)
        }
      })
    })

    it('should use smaller slices near z=0', () => {
      const slices = selectSlices(0, 1, 200)
      
      // Find slices near z=0 and far from z=0
      const nearSlices = slices.filter(s => Math.abs(s.depth) < 20)
      const farSlices = slices.filter(s => Math.abs(s.depth) > 100)
      
      if (nearSlices.length > 0 && farSlices.length > 0) {
        const avgNearSize = nearSlices.reduce((sum, s) => sum + s.size, 0) / nearSlices.length
        const avgFarSize = farSlices.reduce((sum, s) => sum + s.size, 0) / farSlices.length
        
        // Near slices should have smaller average size than far slices
        expect(avgNearSize).toBeLessThanOrEqual(avgFarSize)
      }
    })
  })

  describe('Camera position handling', () => {
    it('should work with camera at position 0', () => {
      const slices = selectSlices(0, 1, 200)
      expect(slices.length).toBeGreaterThan(0)
      
      // Verify contiguity
      for (let i = 0; i < slices.length - 1; i++) {
        const currentEnd = slices[i].depth + slices[i].size
        const nextStart = slices[i + 1].depth
        expect(currentEnd).toBe(nextStart)
      }
    })

    it('should work with camera at position 50', () => {
      const slices = selectSlices(50, 51, 250)
      expect(slices.length).toBeGreaterThan(0)
      
      // Verify contiguity
      for (let i = 0; i < slices.length - 1; i++) {
        const currentEnd = slices[i].depth + slices[i].size
        const nextStart = slices[i + 1].depth
        expect(currentEnd).toBe(nextStart)
      }
    })

    it('should work with negative camera position', () => {
      const slices = selectSlices(-50, 1, 200)
      expect(slices.length).toBeGreaterThan(0)
      
      // Verify contiguity
      for (let i = 0; i < slices.length - 1; i++) {
        const currentEnd = slices[i].depth + slices[i].size
        const nextStart = slices[i + 1].depth
        expect(currentEnd).toBe(nextStart)
      }
    })
  })

  describe('Edge cases', () => {
    it('should return empty array when minZ >= maxZ', () => {
      const slices = selectSlices(0, 200, 100)
      expect(slices).toEqual([])
    })

    it('should handle small range', () => {
      const slices = selectSlices(0, 5, 10)
      expect(slices.length).toBeGreaterThan(0)
      
      // Verify contiguity
      for (let i = 0; i < slices.length - 1; i++) {
        const currentEnd = slices[i].depth + slices[i].size
        const nextStart = slices[i + 1].depth
        expect(currentEnd).toBe(nextStart)
      }
    })

    it('should handle large range', () => {
      const slices = selectSlices(0, 1, 1000)
      expect(slices.length).toBeGreaterThan(0)
      
      // Verify contiguity
      for (let i = 0; i < slices.length - 1; i++) {
        const currentEnd = slices[i].depth + slices[i].size
        const nextStart = slices[i + 1].depth
        expect(currentEnd).toBe(nextStart)
      }
    })
  })

  describe('Observed bug scenario', () => {
    it('should not have holes like in the reported bug', () => {
      // The bug showed gaps at z: 48-63, 96-127, 160-191
      const slices = selectSlices(0, 1, 256)
      
      // Verify there are no gaps in coverage
      for (let i = 0; i < slices.length - 1; i++) {
        const currentEnd = slices[i].depth + slices[i].size
        const nextStart = slices[i + 1].depth
        expect(currentEnd).toBe(nextStart)
      }
      
      // Specifically check that the problematic z values are covered
      const coversZ = (z: number): boolean => {
        return slices.some(s => s.depth <= z && s.depth + s.size > z)
      }
      
      // Check z values that were in gaps
      for (let z = 1; z < 256; z++) {
        const covered = coversZ(z)
        if (!covered) {
          // Debug output if we find a gap
          console.error(`Gap found at z=${String(z)}`)
        }
        expect(covered).toBe(true)
      }
    })
  })

  describe('Camera-independent slicing (fixed world boundaries)', () => {
    it('should maintain fixed world boundaries when camera moves', () => {
      // When camera moves, slices at same world z should have same boundaries
      const camera1 = -30
      const camera2 = -28  // Camera moved forward by 2 units
      
      const slices1 = selectSlices(camera1, 1, 100)
      const slices2 = selectSlices(camera2, 1, 100)
      
      // Find slices that overlap in world z-coordinates
      const sliceMap1 = new Map(slices1.map(s => [s.depth, s]))
      const sliceMap2 = new Map(slices2.map(s => [s.depth, s]))
      
      // Common world z-coordinates should have same slice boundaries
      let commonCount = 0
      sliceMap1.forEach((slice1, depth) => {
        const slice2 = sliceMap2.get(depth)
        if (slice2) {
          expect(slice1.size).toBe(slice2.size)
          commonCount++
        }
      })
      
      // There should be many common slices (overlapping visible ranges)
      expect(commonCount).toBeGreaterThan(5)
    })

    it('should produce same slices for same world z range', () => {
      // Same world z range should produce identical slices regardless of camera
      const slices1 = generateSlicesForRange(0, 100)
      const slices2 = generateSlicesForRange(0, 100)
      
      expect(slices1).toEqual(slices2)
    })
    
    it('should have consistent slice for any given world z-coordinate', () => {
      // Any world z-coordinate should be in the same slice regardless of camera position
      const targetZ = 32  // A specific world z-coordinate
      
      const cameraPositions = [-50, -30, 0, 20, 40]
      const containingSlices = cameraPositions
        .map(cameraZ => {
          const slices = selectSlices(cameraZ, 1, 100)
          const minVisible = cameraZ + 1
          const maxVisible = cameraZ + 100
          
          // Only check if targetZ is visible
          if (targetZ >= minVisible && targetZ < maxVisible) {
            return slices.find(s => s.depth <= targetZ && s.depth + s.size > targetZ)
          }
          return null
        })
        .filter((s): s is NonNullable<typeof s> => s !== null)
      
      // All cameras that can see z=32 should have same slice boundaries
      if (containingSlices.length > 1) {
        const first = containingSlices[0]
        containingSlices.forEach(slice => {
          expect(slice.depth).toBe(first.depth)
          expect(slice.size).toBe(first.size)
        })
      }
    })
  })

  describe('O(log n) slice count', () => {
    it('should use O(log n) slices for distance n (geometric progression)', () => {
      // For distance n, the number of slices should be roughly proportional to log2(n)
      // due to the geometric progression where each slice doubles in size
      
      // Test with various distances
      const testCases = [
        { distance: 100, expectedMaxSlices: 20 },   // log2(100) ≈ 6.6, with maxSize cap
        { distance: 1000, expectedMaxSlices: 25 },  // log2(1000) ≈ 10, with maxSize cap
        { distance: 10000, expectedMaxSlices: 170 }, // log2(10000) ≈ 13, with maxSize cap
      ]
      
      testCases.forEach(({ distance, expectedMaxSlices }) => {
        const slices = selectSlices(0, 1, distance)
        
        // The slice count should be bounded by O(log n) plus a linear term 
        // for the maxSize-capped portion
        expect(slices.length).toBeLessThanOrEqual(expectedMaxSlices)
        expect(slices.length).toBeGreaterThan(0)
      })
    })

    it('should use fewer slices than a linear slicing approach', () => {
      // For distance 200, a linear approach with size=1 would need 199 slices
      // Our geometric approach should use significantly fewer
      const slices = selectSlices(0, 1, 200)
      
      // Linear approach would use ~199 slices
      // Geometric approach should use much less
      expect(slices.length).toBeLessThan(50)
    })

    it('should show geometric progression of slice sizes', () => {
      const slices = selectSlices(0, 1, 100)
      
      // Check that early slices follow geometric progression: 1, 2, 4, 8, 16, 32, 64
      const expectedSizes = [1, 2, 4, 8, 16, 32, 64]
      const actualSizes = slices.slice(0, expectedSizes.length).map(s => s.size)
      
      expect(actualSizes).toEqual(expectedSizes)
    })
  })

  describe('Slice stability during camera movement', () => {
    it('should not have missing slices when camera moves forward', () => {
      // Test that slices remain stable as camera moves forward
      // This tests the bug: "missing slices that appear randomly when moving in/out"
      const cameraPositions = [-50, -40, -30, -20, -10, 0, 10, 20, 30]
      
      cameraPositions.forEach(cameraZ => {
        const slices = selectSlices(cameraZ, 1, 100)
        
        // There should always be slices
        expect(slices.length).toBeGreaterThan(0)
        
        // No gaps between slices
        for (let i = 0; i < slices.length - 1; i++) {
          const currentEnd = slices[i].depth + slices[i].size
          const nextStart = slices[i + 1].depth
          expect(currentEnd).toBe(nextStart)
        }
        
        // First slice should cover camera + minRelativeDepth
        const minVisibleZ = cameraZ + 1
        expect(slices[0].depth).toBeLessThanOrEqual(minVisibleZ)
        expect(slices[0].depth + slices[0].size).toBeGreaterThan(minVisibleZ)
      })
    })

    it('should maintain same world slice boundaries during camera movement', () => {
      // When camera moves, the same world z should be in the same slice
      const cameraPositions = [-100, -50, 0, 50, 100]
      
      // Check that world z=80 is always in the same slice (when visible)
      const targetZ = 80
      const containingSlices = cameraPositions
        .map(cameraZ => {
          const minVisible = cameraZ + 1
          const maxVisible = cameraZ + 100
          if (targetZ >= minVisible && targetZ < maxVisible) {
            const slices = selectSlices(cameraZ, 1, 100)
            return slices.find(s => s.depth <= targetZ && s.depth + s.size > targetZ)
          }
          return null
        })
        .filter((s): s is NonNullable<typeof s> => s !== null)
      
      // All should have same boundaries
      if (containingSlices.length > 1) {
        containingSlices.forEach(slice => {
          expect(slice.depth).toBe(containingSlices[0].depth)
          expect(slice.size).toBe(containingSlices[0].size)
        })
      }
    })

    it('should always produce contiguous coverage during smooth movement', () => {
      // Simulate smooth camera movement and verify contiguity
      const steps = 20
      const startZ = -30
      const endZ = 10
      
      for (let i = 0; i <= steps; i++) {
        const cameraZ = startZ + (endZ - startZ) * (i / steps)
        const slices = selectSlices(cameraZ, 1, 100)
        
        // Verify contiguity at each step
        for (let j = 0; j < slices.length - 1; j++) {
          const currentEnd = slices[j].depth + slices[j].size
          const nextStart = slices[j + 1].depth
          expect(currentEnd).toBe(nextStart)
        }
      }
    })
  })

  describe('Slice density based on absolute z', () => {
    it('should have smaller slices near z=0 and larger slices far away', () => {
      // Slice sizes are based on absolute z-coordinate
      const slices = selectSlices(0, 1, 200)
      
      // First slice (at z=1) should have small size
      expect(slices[0].size).toBeLessThanOrEqual(2)
      
      // Slices generally increase in size as z increases
      // (though may not be monotonic due to alignment)
      const nearSlices = slices.filter(s => Math.abs(s.depth) < 10)
      const farSlices = slices.filter(s => Math.abs(s.depth) >= 64)
      
      if (nearSlices.length > 0 && farSlices.length > 0) {
        const avgNearSize = nearSlices.reduce((sum, s) => sum + s.size, 0) / nearSlices.length
        const avgFarSize = farSlices.reduce((sum, s) => sum + s.size, 0) / farSlices.length
        expect(avgNearSize).toBeLessThanOrEqual(avgFarSize)
      }
    })

    it('should get denser (more slices) near z=0 than far from z=0', () => {
      // Near z=0 should have more detail (smaller slices)
      const nearSlices = generateSlicesForRange(1, 16)   // 15 units near z=0
      const farSlices = generateSlicesForRange(100, 115) // 15 units far from z=0
      
      // Near slices have smaller average size
      const avgNearSize = nearSlices.reduce((s, x) => s + x.size, 0) / nearSlices.length
      const avgFarSize = farSlices.reduce((s, x) => s + x.size, 0) / farSlices.length
      
      expect(avgNearSize).toBeLessThan(avgFarSize)
    })

    it('should follow geometric progression based on absolute z', () => {
      const slices = selectSlices(0, 1, 200)
      
      // Check that slices follow power-of-2 progression
      slices.forEach(slice => {
        const absZ = Math.abs(slice.depth)
        if (absZ >= 1) {
          const expectedMaxSize = Math.min(64, Math.pow(2, Math.floor(Math.log2(absZ))))
          expect(slice.size).toBeLessThanOrEqual(expectedMaxSize)
        }
      })
    })

    it('should have increasing depths for consecutive slices', () => {
      const cameraZ = -30
      const slices = selectSlices(cameraZ, 1, 100)
      
      // Check that each slice depth is greater than the previous
      slices.forEach((slice, index) => {
        if (index > 0) {
          expect(slice.depth).toBeGreaterThan(slices[index - 1].depth)
        }
      })
    })
  })

  describe('Slice size calculation (via selectSlices)', () => {
    // Tests verify getSliceSizeForAbsoluteZ behavior indirectly through selectSlices
    it('should return appropriate size based on absolute z', () => {
      // Slices at z=1 should have size 1
      const slices = selectSlices(0, 1, 2)
      expect(slices[0].size).toBe(1)
    })

    it('should return power of 2 for each absolute z threshold', () => {
      // Test specific absolute z thresholds using generateSlicesForRange
      const testCases = [
        { z: 1, expectedSize: 1 },
        { z: 2, expectedSize: 2 },
        { z: 4, expectedSize: 4 },
        { z: 8, expectedSize: 8 },
        { z: 16, expectedSize: 16 },
        { z: 32, expectedSize: 32 },
        { z: 64, expectedSize: 64 },
        { z: 128, expectedSize: 64 }, // Capped at 64
      ]
      
      testCases.forEach(({ z, expectedSize }) => {
        const size = getSliceSizeForAbsoluteZ(z)
        expect(size).toBe(expectedSize)
      })
    })
  })
})
