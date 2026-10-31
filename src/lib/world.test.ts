import { describe, it, expect } from 'vitest'
import { World, WORLD_TYPES } from './world'

describe('World', () => {
  // The forest's determinism is checked in forest.test.ts; comparing it here is slow.
  const smallWorlds = WORLD_TYPES.map(t => t.value).filter(t => t !== 'forest')

  it('is deterministic for a given seed and type', () => {
    for (const value of smallWorlds) {
      expect(new World(42, value).voxels).toEqual(new World(42, value).voxels)
    }
  })

  it('varies with the seed', () => {
    expect(new World(42, 'hills_with_trees').voxels.length).not.toBe(new World(99, 'hills_with_trees').voxels.length)
  })

  it.each(smallWorlds)('generates a %s world with a grass surface', worldType => {
    const world = new World(12345, worldType)
    expect(world.worldType).toBe(worldType)
    expect(world.voxels.some(v => v.type === 1)).toBe(true)
    // Columns are filled from bedrock at y=-5 within x, z in [-40, 40);
    // trees may overhang the edge by their 2-block canopy radius.
    let minY = Infinity
    let maxXZ = 0
    for (const v of world.voxels) {
      minY = Math.min(minY, v.y)
      maxXZ = Math.max(maxXZ, Math.abs(v.x + 0.5), Math.abs(v.z + 0.5))
    }
    expect(minY).toBe(-5)
    expect(maxXZ).toBeLessThanOrEqual(42.5)
  })

  it('puts water around the island in the lake world', () => {
    const world = new World(12345, 'lake_with_island')
    const surfaceAt = (x: number, z: number) =>
      world.voxels.filter(v => v.x === x && v.z === z).reduce((top, v) => (v.y > top.y ? v : top))
    expect(surfaceAt(15, 0).type).toBe(8) // water
    expect(surfaceAt(0, 0).type).not.toBe(8)
  })

  it('selects voxels by absolute z range', () => {
    const world = new World(12345, 'hills')
    const voxels = world.getVoxelsInZRange(-10, -6)
    expect(voxels.length).toBeGreaterThan(0)
    expect(voxels.every(v => v.z >= -10 && v.z < -6)).toBe(true)
    expect(voxels.length).toBe(world.voxels.filter(v => v.z >= -10 && v.z < -6).length)
  })
})
