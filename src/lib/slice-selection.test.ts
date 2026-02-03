import { describe, it, expect } from 'vitest'
import { selectSlices } from './slice-selection'

describe('Slice Selection', () => {
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

    it('should use viewing distance for size calculation', () => {
      const slices = selectSlices(0, 1, 200)
      
      // Each slice's size should match the geometric progression based on viewing distance
      slices.forEach(slice => {
        const viewingDistance = slice.depth // camera at 0, so depth = viewing distance
        // Size should be largest power of 2 <= viewing distance
        const expectedMaxSize = Math.pow(2, Math.floor(Math.log2(Math.max(1, viewingDistance))))
        // Capped at 64
        const cappedExpectedMaxSize = Math.min(64, expectedMaxSize)
        expect(slice.size).toBeLessThanOrEqual(cappedExpectedMaxSize)
      })
    })

    it('should use smaller slices near camera', () => {
      const cameraZ = 0
      const slices = selectSlices(cameraZ, 1, 200)
      
      // Find slices near camera (depth < 20) and far from camera (depth > 100)
      const nearSlices = slices.filter(s => s.depth < 20)
      const farSlices = slices.filter(s => s.depth > 100)
      
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

  describe('Viewing distance based slicing (smooth z-movement)', () => {
    it('should maintain consistent viewing distance progression regardless of camera position', () => {
      // The slice progression should be the same relative to camera position
      // Slices are based on viewing distance, so they follow the camera
      const camera1 = -30
      const camera2 = -28  // Camera moved forward by 2 units
      
      const slices1 = selectSlices(camera1, 1, 100)
      const slices2 = selectSlices(camera2, 1, 100)
      
      // Same number of slices (same viewing distance range)
      expect(slices1.length).toBe(slices2.length)
      
      // Same relative positions (viewing distances)
      for (let i = 0; i < slices1.length; i++) {
        const viewDist1 = slices1[i].depth - camera1
        const viewDist2 = slices2[i].depth - camera2
        expect(viewDist1).toBe(viewDist2)
        
        // Same sizes for same viewing distances
        expect(slices1[i].size).toBe(slices2[i].size)
      }
    })

    it('should produce denser slices when moving closer to objects', () => {
      // When camera moves forward, slices shift forward with it
      // Objects that were far (large slices) become near (small slices)
      const cameraFar = 0
      const cameraClose = 50
      
      const slicesFar = selectSlices(cameraFar, 1, 100)
      const slicesClose = selectSlices(cameraClose, 1, 100)
      
      // Both should have same structure since viewing distance range is same
      expect(slicesFar.length).toBe(slicesClose.length)
      
      // The first slice should be close to camera in both cases
      expect(slicesFar[0].depth - cameraFar).toBe(1)
      expect(slicesClose[0].depth - cameraClose).toBe(1)
      
      // Near slices should have smaller sizes
      expect(slicesFar[0].size).toBe(1)
      expect(slicesClose[0].size).toBe(1)
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
        
        // Coverage should start at camera + minRelativeDepth
        expect(slices[0].depth).toBe(cameraZ + 1)
      })
    })

    it('should have consistent slice count for same viewing range', () => {
      // Moving the camera should not change the number of slices
      // since the viewing distance range (1-100) is constant
      const cameraPositions = [-100, -50, 0, 50, 100]
      const sliceCounts = cameraPositions.map(cameraZ => 
        selectSlices(cameraZ, 1, 100).length
      )
      
      // All should have the same count
      const expectedCount = sliceCounts[0]
      sliceCounts.forEach(count => {
        expect(count).toBe(expectedCount)
      })
    })

    it('should not randomly add or remove slices during smooth movement', () => {
      // Simulate smooth camera movement and verify slice stability
      const steps = 20
      const startZ = -30
      const endZ = 10
      
      let previousSliceCount: number | null = null
      
      for (let i = 0; i <= steps; i++) {
        const cameraZ = startZ + (endZ - startZ) * (i / steps)
        const slices = selectSlices(cameraZ, 1, 100)
        
        // Slice count should remain constant during movement
        if (previousSliceCount !== null) {
          expect(slices.length).toBe(previousSliceCount)
        }
        previousSliceCount = slices.length
        
        // Verify contiguity at each step
        for (let j = 0; j < slices.length - 1; j++) {
          const currentEnd = slices[j].depth + slices[j].size
          const nextStart = slices[j + 1].depth
          expect(currentEnd).toBe(nextStart)
        }
      }
    })
  })

  describe('Slice density based on viewing distance', () => {
    it('should have smaller slices near camera and larger slices far away', () => {
      // This tests the bug: "slices are not getting any denser when moving in"
      const slices = selectSlices(0, 1, 200)
      
      // First slice (nearest) should be smallest
      expect(slices[0].size).toBe(1)
      
      // Slices should never decrease in size as viewing distance increases
      for (let i = 1; i < slices.length; i++) {
        expect(slices[i].size).toBeGreaterThanOrEqual(slices[i - 1].size)
      }
    })

    it('should get denser (more slices) when viewing a smaller range', () => {
      // Near range should have more detail (more slices per unit distance)
      const nearSlices = selectSlices(0, 1, 16)   // 15 units
      const farSlices = selectSlices(0, 100, 115) // 15 units, but farther
      
      // Near range has slices: 1, 2, 4, 8 = 4 slices for 15 units
      // Far range might have fewer slices (larger sizes)
      
      // Near slices have smaller average size
      const avgNearSize = nearSlices.reduce((s, x) => s + x.size, 0) / nearSlices.length
      const avgFarSize = farSlices.reduce((s, x) => s + x.size, 0) / farSlices.length
      
      expect(avgNearSize).toBeLessThan(avgFarSize)
    })

    it('should follow geometric progression: 1, 2, 4, 8, 16, 32, 64', () => {
      const slices = selectSlices(0, 1, 200)
      
      // First 7 slices should have sizes 1, 2, 4, 8, 16, 32, 64
      const expectedProgression = [1, 2, 4, 8, 16, 32, 64]
      
      for (let i = 0; i < Math.min(expectedProgression.length, slices.length); i++) {
        expect(slices[i].size).toBe(expectedProgression[i])
      }
    })

    it('should correctly calculate viewing distances for all slices', () => {
      const cameraZ = -30
      const slices = selectSlices(cameraZ, 1, 100)
      
      // Check that each slice's viewing distance matches its size
      slices.forEach((slice, index) => {
        const viewingDistance = slice.depth - cameraZ
        
        // Viewing distance should increase with each slice
        if (index > 0) {
          const prevViewingDistance = slices[index - 1].depth - cameraZ
          expect(viewingDistance).toBeGreaterThan(prevViewingDistance)
        }
        
        // Size should be appropriate for the viewing distance
        // (largest power of 2 <= viewing distance, capped at 64)
        const expectedMaxSize = Math.min(64, Math.pow(2, Math.floor(Math.log2(viewingDistance))))
        expect(slice.size).toBeLessThanOrEqual(expectedMaxSize)
      })
    })
  })

  describe('getSliceSizeForViewingDistance function', () => {
    // Import the function for direct testing
    it('should return 1 for viewing distance < 2', () => {
      const slices = selectSlices(0, 1, 2)
      expect(slices[0].size).toBe(1)
    })

    it('should return power of 2 for each viewing distance threshold', () => {
      // Test specific thresholds
      const testCases = [
        { viewDist: 1, expectedSize: 1 },
        { viewDist: 2, expectedSize: 2 },
        { viewDist: 4, expectedSize: 4 },
        { viewDist: 8, expectedSize: 8 },
        { viewDist: 16, expectedSize: 16 },
        { viewDist: 32, expectedSize: 32 },
        { viewDist: 64, expectedSize: 64 },
        { viewDist: 128, expectedSize: 64 }, // Capped at 64
      ]
      
      testCases.forEach(({ viewDist, expectedSize }) => {
        // Create slices starting at exactly viewDist
        const slices = selectSlices(0, viewDist, viewDist + 100)
        expect(slices[0].size).toBe(expectedSize)
      })
    })
  })
})
