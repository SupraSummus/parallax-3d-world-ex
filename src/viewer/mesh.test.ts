import { describe, it, expect } from 'vitest'
import { World } from '@/lib/world'
import { buildVoxelMesh } from './mesh'

function worldOf(cells: [number, number, number][]): World {
  const world = new World(1, 'hills') // cheapest world to generate; its voxels are replaced
  world.voxels = cells.map(([x, y, z]) => ({ x, y, z, color: '#808080', type: 3 }))
  return world
}

describe('buildVoxelMesh', () => {
  it('emits only faces not covered by a neighbour', () => {
    expect(buildVoxelMesh(worldOf([[0, 0, 0]])).faceCount).toBe(6)
    expect(buildVoxelMesh(worldOf([[0, 0, 0], [1, 0, 0]])).faceCount).toBe(10)
    expect(buildVoxelMesh(worldOf([[0, 0, 0], [0, 0, 1], [0, 1, 0]])).faceCount).toBe(14)
  })

  it('places voxel (x, y, z) at (x, y, -z) ± 0.5', () => {
    const { positions } = buildVoxelMesh(worldOf([[2, 3, 4]]))
    const axis = (i: number) => positions.filter((_, j) => j % 3 === i)
    expect([Math.min(...axis(0)), Math.max(...axis(0))]).toEqual([1.5, 2.5])
    expect([Math.min(...axis(1)), Math.max(...axis(1))]).toEqual([2.5, 3.5])
    expect([Math.min(...axis(2)), Math.max(...axis(2))]).toEqual([-4.5, -3.5])
  })

  it('winds every triangle counter-clockwise seen from outside', () => {
    const { positions, indices } = buildVoxelMesh(worldOf([[0, 0, 0]]))
    const vertex = (i: number) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]].map(vertex)
      const u = b.map((v, k) => v - a[k])
      const w = c.map((v, k) => v - a[k])
      const normal = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
      // Outward: same direction as the triangle's centroid seen from the cube centre (the origin).
      const centroid = [0, 1, 2].map(k => (a[k] + b[k] + c[k]) / 3)
      expect(normal.reduce((sum, n, k) => sum + n * centroid[k], 0)).toBeGreaterThan(0)
    }
  })
})
