import { describe, it, expect } from 'vitest'
import { generateForest, VOXEL_SIZE } from './forest'
import type { Voxel } from './voxel-grid'

// Generation takes a while; every test only reads the result.
const { grid, spawn } = generateForest(42)
const voxels = grid.toVoxels()
const key = (x: number, y: number, z: number) => `${String(x)},${String(y)},${String(z)}`
const fingerprint = (vs: Voxel[]) => vs.map(v => key(v.x, v.y, v.z) + v.color).join(';')

describe('generateForest', () => {
  // The 3D viewer rebuilds the app's world from its seed.
  it('is deterministic for a seed', () => {
    const again = generateForest(42)
    expect(again.spawn).toEqual(spawn)
    expect(fingerprint(again.grid.toVoxels())).toBe(fingerprint(voxels))
  })

  it('has ground under every column of a 96 m × 160 m area', () => {
    const columns = new Set(voxels.map(v => `${String(v.x)},${String(v.z)}`))
    expect(columns.size).toBe((96 / VOXEL_SIZE) * (160 / VOXEL_SIZE))
  })

  it('stays within a voxel budget the slice renderer can handle', () => {
    expect(voxels.length).toBeLessThan(1_000_000)
  })

  it('grows trees between 10 m and 25 m tall', () => {
    // Longest vertical run of wood in any column.
    const wood = voxels.filter(v => v.type === 4).sort((a, b) => a.x - b.x || a.z - b.z || a.y - b.y)
    let longest = 0
    let run = 0
    wood.forEach((v, i) => {
      const prev = wood[i - 1] as Voxel | undefined
      run = prev?.x === v.x && prev.z === v.z && prev.y === v.y - 1 ? run + 1 : 1
      longest = Math.max(longest, run)
    })
    expect(longest * VOXEL_SIZE).toBeGreaterThan(10)
    expect(longest * VOXEL_SIZE).toBeLessThan(25)
  })

  it('starts the camera in open air with a clear view ahead', () => {
    const cells = new Set(voxels.map(v => key(v.x, v.y, v.z)))
    for (let dz = 0; dz < 4 / VOXEL_SIZE; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          expect(cells.has(key(spawn.x + dx, spawn.y + dy, spawn.z + dz))).toBe(false)
        }
      }
    }
  })
})
