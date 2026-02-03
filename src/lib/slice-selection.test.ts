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

    it('should align slices to their size boundaries', () => {
      const slices = selectSlices(0, 1, 200)
      
      slices.forEach(slice => {
        expect(slice.depth % slice.size).toBe(0)
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

  describe('Fixed layer boundaries (smooth z-movement)', () => {
    it('should maintain fixed layer boundaries when camera moves slightly', () => {
      // When camera moves by a small amount, layers that overlap
      // should have the SAME absolute z-boundaries
      const camera1 = -30
      const camera2 = -28  // Camera moved forward by 2 units
      
      const slices1 = selectSlices(camera1, 1, 100)
      const slices2 = selectSlices(camera2, 1, 100)
      
      // Find layers that exist in both selections (overlapping range)
      // The overlapping range is approximately camera1+1 to camera2+100
      // which is -29 to 72
      
      const sliceMap1 = new Map(slices1.map(s => [s.depth, s]))
      const sliceMap2 = new Map(slices2.map(s => [s.depth, s]))
      
      // Check that common layers (by absolute z) have the same boundaries
      let commonLayers = 0
      sliceMap1.forEach((slice1, depth) => {
        const slice2 = sliceMap2.get(depth)
        if (slice2) {
          // Same absolute depth should have same size
          expect(slice1.size).toBe(slice2.size)
          commonLayers++
        }
      })
      
      // There should be common layers between the two camera positions
      // With O(log n) geometric progression, we have fewer but larger slices
      expect(commonLayers).toBeGreaterThanOrEqual(5)
    })

    it('should produce layers at fixed absolute z coordinates', () => {
      // Layers with the same absolute z coordinate should appear
      // regardless of camera position
      const checkZ = 32  // An absolute z-coordinate to check
      
      // Test with different camera positions
      const cameraPositions = [-50, -30, 0, 20]
      
      cameraPositions.forEach(cameraZ => {
        // Only check if z=32 is in visible range
        const minVisibleZ = cameraZ + 1
        const maxVisibleZ = cameraZ + 100
        
        if (checkZ >= minVisibleZ && checkZ < maxVisibleZ) {
          const slices = selectSlices(cameraZ, 1, 100)
          
          // Find the slice that contains z=32
          const containingSlice = slices.find(s => 
            s.depth <= checkZ && s.depth + s.size > checkZ
          )
          
          expect(containingSlice).toBeDefined()
          if (containingSlice) {
            // The slice should be aligned to its size
            expect(containingSlice.depth % containingSlice.size === 0).toBe(true)
          }
        }
      })
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
})
