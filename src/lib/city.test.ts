import { describe, it, expect } from 'vitest'
import { CITY_VOXEL_SIZE, generateCity } from './city'

// Generation takes a while; every test only reads the result.
const { grid, spawn } = generateCity(42)
const vox = (metres: number) => metres / CITY_VOXEL_SIZE

describe('generateCity', () => {
  // The 3D viewer rebuilds the app's world from its seed.
  it('is deterministic for a seed', () => {
    const again = generateCity(42)
    expect(again.spawn).toEqual(spawn)
    expect(again.grid.materials).toEqual(grid.materials)
    // toEqual on ~12M cells runs out of memory.
    expect(again.grid.cells.every((id, i) => id === grid.cells[i])).toBe(true)
  })

  it('stays within a voxel budget the slice renderer can handle', () => {
    expect(grid.cells.filter(id => id !== 0).length).toBeLessThan(1_000_000)
  })

  it('starts at eye height on the road, looking through an open entrance into a room', () => {
    expect(grid.get(spawn.x, spawn.y - vox(1.75), spawn.z)).not.toBe(0)
    // The building's front: the first thing ahead 2 m above the eyes, over the doorway.
    let front = spawn.z
    while (grid.get(spawn.x, spawn.y + vox(2), front) === 0) front++
    // From eye height to the top of the door: clear through the doorway and into the room.
    for (let z = spawn.z; z < front + vox(3); z++) {
      for (let dy = 0; dy <= 2; dy++) expect(grid.get(spawn.x, spawn.y + dy, z), `z = ${String(z)}`).toBe(0)
    }
  })
})
