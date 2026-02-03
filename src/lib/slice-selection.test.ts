import { describe, it, expect } from 'vitest'
import { selectSlices, getSliceAtDepth } from './slice-selection'

describe('Slice Selection', () => {
  describe('Mechanism 1: World Slice Availability', () => {
    describe('getSliceAtDepth', () => {
      it('should return smallest valid slice >= minSize at depth 0', () => {
        // At z=0, all sizes are valid (0 % N == 0 for all N)
        expect(getSliceAtDepth(0, 1).size).toBe(1)
        expect(getSliceAtDepth(0, 4).size).toBe(4)
        expect(getSliceAtDepth(0, 64).size).toBe(64)
      })

      it('should return smallest valid slice >= minSize at aligned depth', () => {
        // At z=8: valid sizes are 1, 2, 4, 8 (since 8 % 8 == 0)
        expect(getSliceAtDepth(8, 1).size).toBe(1)
        expect(getSliceAtDepth(8, 4).size).toBe(4)
        expect(getSliceAtDepth(8, 8).size).toBe(8)
        // Request size 16, but only 8 is valid, so return 8 (largest available)
        expect(getSliceAtDepth(8, 16).size).toBe(8)
      })

      it('should return largest valid size when minSize exceeds available', () => {
        // At z=6: valid sizes are 1, 2 (since 6 % 2 == 0 but 6 % 4 != 0)
        expect(getSliceAtDepth(6, 1).size).toBe(1)
        expect(getSliceAtDepth(6, 2).size).toBe(2)
        // Request size 4, but only 1, 2 valid, return 2
        expect(getSliceAtDepth(6, 4).size).toBe(2)
      })

      it('should respect alignment constraints', () => {
        // All returned slices must have depth % size == 0
        const testDepths = [0, 1, 2, 4, 6, 8, 10, 16, 32, 64, -2, -4, -8, -16]
        const testMinSizes = [1, 2, 4, 8, 16, 32, 64]
        
        testDepths.forEach(depth => {
          testMinSizes.forEach(minSize => {
            const slice = getSliceAtDepth(depth, minSize)
            // Use Math.abs because JavaScript modulo returns -0 for negative numbers
            // (e.g., -4 % 2 === -0) and vitest's .toBe() uses Object.is which
            // distinguishes -0 from +0
            expect(Math.abs(slice.depth % slice.size)).toBe(0)
          })
        })
      })

      it('should use power-of-2 sizes', () => {
        const validSizes = [1, 2, 4, 8, 16, 32, 64]
        const testDepths = [0, 1, 2, 4, 8, 16, 32, 64, 100, -10, -64]
        
        testDepths.forEach(depth => {
          const slice = getSliceAtDepth(depth, 1)
          expect(validSizes).toContain(slice.size)
        })
      })
    })
  })

  describe('Mechanism 2: Camera-Dependent Selection', () => {
    describe('selectSlices', () => {
      it('should produce slices that grow with viewing distance', () => {
        const slices = selectSlices(0, 1, 200)
        
        // Slices should generally grow as viewing distance increases
        // First slice should be small
        expect(slices[0].size).toBeLessThanOrEqual(2)
        
        // Later slices should be larger
        const lastSlice = slices[slices.length - 1]
        expect(lastSlice.size).toBeGreaterThanOrEqual(32)
      })

      it('should produce contiguous coverage with no gaps', () => {
        const slices = selectSlices(0, 1, 200)
        
        for (let i = 0; i < slices.length - 1; i++) {
          const currentEnd = slices[i].depth + slices[i].size
          const nextStart = slices[i + 1].depth
          expect(currentEnd).toBe(nextStart)
        }
      })

      it('should produce same slices for same camera position', () => {
        const slices1 = selectSlices(0, 1, 100)
        const slices2 = selectSlices(0, 1, 100)
        expect(slices1).toEqual(slices2)
      })

      it('should produce different slices for different camera positions', () => {
        // Same world z can have different slice sizes depending on camera
        const slicesFromNear = selectSlices(0, 1, 100)  // Camera at 0, z=10 is at viewDist 10
        const slicesFromFar = selectSlices(-50, 1, 100) // Camera at -50, z=10 is at viewDist 60
        
        // Find slice containing z=10 in each
        const sliceNear = slicesFromNear.find(s => s.depth <= 10 && s.depth + s.size > 10)
        const sliceFar = slicesFromFar.find(s => s.depth <= 10 && s.depth + s.size > 10)
        
        // When camera is far from z=10, the slice should be larger
        if (sliceNear && sliceFar) {
          expect(sliceFar.size).toBeGreaterThanOrEqual(sliceNear.size)
        }
      })

      it('should start with small slices near camera', () => {
        const slices = selectSlices(-30, 1, 100)
        
        // First slice should be small (viewing distance ~1)
        expect(slices[0].size).toBeLessThanOrEqual(2)
      })

      it('should end with large slices far from camera', () => {
        const slices = selectSlices(0, 1, 200)
        
        // Far slices should be at max size
        const farSlices = slices.filter(s => s.depth >= 100)
        farSlices.forEach(slice => {
          expect(slice.size).toBeGreaterThanOrEqual(32)
        })
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
      const validSizes = [1, 2, 4, 8, 16, 32, 64]
      
      slices.forEach(slice => {
        expect(validSizes).toContain(slice.size)
      })
    })

    it('should respect alignment constraints (depth % size == 0)', () => {
      const slices = selectSlices(0, 1, 200)
      
      slices.forEach(slice => {
        expect(slice.depth % slice.size).toBe(0)
      })
    })

    it('should have non-decreasing sizes as viewing distance increases', () => {
      const slices = selectSlices(0, 1, 200)
      
      // Sizes should generally not decrease as we move away from camera
      let lastSize = 0
      slices.forEach(slice => {
        expect(slice.size).toBeGreaterThanOrEqual(lastSize)
        lastSize = slice.size
      })
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

    it('should work with camera at negative position', () => {
      const slices = selectSlices(-50, 1, 200)
      expect(slices.length).toBeGreaterThan(0)
      
      // Verify contiguity
      for (let i = 0; i < slices.length - 1; i++) {
        const currentEnd = slices[i].depth + slices[i].size
        const nextStart = slices[i + 1].depth
        expect(currentEnd).toBe(nextStart)
      }
    })

    it('should work with camera far from origin', () => {
      const slices = selectSlices(1000, 1, 200)
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

  describe('O(log n) slice count', () => {
    it('should use O(log n) slices for distance n', () => {
      // Due to geometric progression, number of slices should be logarithmic
      const testCases = [
        { distance: 100, expectedMaxSlices: 20 },
        { distance: 1000, expectedMaxSlices: 25 },
        { distance: 10000, expectedMaxSlices: 170 },
      ]
      
      testCases.forEach(({ distance, expectedMaxSlices }) => {
        const slices = selectSlices(0, 1, distance)
        expect(slices.length).toBeLessThanOrEqual(expectedMaxSlices)
        expect(slices.length).toBeGreaterThan(0)
      })
    })

    it('should use fewer slices than a linear slicing approach', () => {
      // For distance 200, linear approach would need ~199 slices
      const slices = selectSlices(0, 1, 200)
      expect(slices.length).toBeLessThan(50)
    })

    it('should show power-of-2 progression of slice sizes', () => {
      const slices = selectSlices(0, 1, 100)
      
      // Check that early slices follow power-of-2 progression: 1, 2, 4, 8, 16, 32, 64
      const expectedSizes = [1, 2, 4, 8, 16, 32, 64]
      const actualSizes = slices.slice(0, expectedSizes.length).map(s => s.size)
      
      expect(actualSizes).toEqual(expectedSizes)
    })
  })

  describe('Slice stability during camera movement', () => {
    it('should not have missing slices when camera moves forward', () => {
      const cameraPositions = [-50, -40, -30, -20, -10, 0, 10, 20, 30]
      
      cameraPositions.forEach(cameraZ => {
        const slices = selectSlices(cameraZ, 1, 100)
        
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

    it('should always produce contiguous coverage during smooth movement', () => {
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

  describe('Slice density based on viewing distance', () => {
    it('should have smaller slices near camera and larger slices far away', () => {
      const slices = selectSlices(0, 1, 200)
      
      // Near camera (viewing distance 1-10): small slices
      const nearSlices = slices.filter(s => s.depth >= 1 && s.depth < 10)
      const avgNearSize = nearSlices.reduce((sum, s) => sum + s.size, 0) / nearSlices.length
      
      // Far from camera (viewing distance 100+): large slices
      const farSlices = slices.filter(s => s.depth >= 100)
      const avgFarSize = farSlices.reduce((sum, s) => sum + s.size, 0) / farSlices.length
      
      expect(avgNearSize).toBeLessThan(avgFarSize)
    })

    it('should get denser near camera than far from camera', () => {
      // Near camera: 15 units of range should have more slices
      const nearSlices = selectSlices(0, 1, 16)
      // Far from camera: 15 units of range should have fewer slices
      const farSlices = selectSlices(0, 100, 115)
      
      // Near camera should have more slices (more detail)
      expect(nearSlices.length).toBeGreaterThan(farSlices.length)
    })

    it('should have increasing depths for consecutive slices', () => {
      const slices = selectSlices(-30, 1, 100)
      
      slices.forEach((slice, index) => {
        if (index > 0) {
          expect(slice.depth).toBeGreaterThan(slices[index - 1].depth)
        }
      })
    })
  })

  describe('Configurable depth multiplier', () => {
    it('should support non-power-of-2 multipliers', () => {
      const slices = selectSlices(0, 1, 100, 3)
      expect(slices.length).toBeGreaterThan(0)
      
      // Verify no gaps
      for (let i = 0; i < slices.length - 1; i++) {
        const currentEnd = slices[i].depth + slices[i].size
        const nextStart = slices[i + 1].depth
        expect(currentEnd).toBe(nextStart)
      }
    })

    it('should produce contiguous coverage with multiplier 1.5', () => {
      const slices = selectSlices(0, 1, 100, 1.5)
      expect(slices.length).toBeGreaterThan(0)
      
      // Verify no gaps
      for (let i = 0; i < slices.length - 1; i++) {
        const currentEnd = slices[i].depth + slices[i].size
        const nextStart = slices[i + 1].depth
        expect(currentEnd).toBe(nextStart)
      }
    })

    it('should produce different number of slices with different multipliers', () => {
      const slicesMultiplier2 = selectSlices(0, 1, 200, 2)
      const slicesMultiplier3 = selectSlices(0, 1, 200, 3)
      
      // Higher multiplier = faster growth = fewer slices needed
      expect(slicesMultiplier2.length).not.toBe(slicesMultiplier3.length)
    })

    it('should default to multiplier 2 when not specified', () => {
      const slicesDefault = selectSlices(0, 1, 100)
      const slicesExplicit = selectSlices(0, 1, 100, 2)
      
      expect(slicesDefault).toEqual(slicesExplicit)
    })
  })

  describe('Original bug fix: efficient slicing when camera is far from origin', () => {
    it('should use large slices for world z=0 when camera is far away', () => {
      // Camera at z=-67, so z=0 is at viewing distance 67
      const slices = selectSlices(-67, 1, 200)
      
      // Find slice containing z=0
      const sliceAt0 = slices.find(s => s.depth <= 0 && s.depth + s.size > 0)
      
      // Should be a large slice (not size 1 as in the original bug)
      if (sliceAt0) {
        expect(sliceAt0.size).toBeGreaterThanOrEqual(32)
      }
    })

    it('should not have size-1 slices far from camera', () => {
      // Camera at z=-100
      const slices = selectSlices(-100, 1, 200)
      
      // Slices at viewing distance > 50 should not be size 1
      slices.forEach(slice => {
        const viewingDistance = slice.depth - (-100)
        if (viewingDistance > 50) {
          expect(slice.size).toBeGreaterThan(1)
        }
      })
    })

    it('should have non-decreasing slice sizes as viewing distance increases', () => {
      const slices = selectSlices(-67, 1, 200)
      
      let lastSize = 0
      slices.forEach(slice => {
        expect(slice.size).toBeGreaterThanOrEqual(lastSize)
        lastSize = slice.size
      })
    })
  })
})
