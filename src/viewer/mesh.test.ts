import { describe, it, expect } from 'vitest'
import { World } from '@/lib/world'
import { buildVoxelMesh } from './mesh'

function worldOf(sites: [number, number, number][]): World {
  const world = new World(1, 'hills') // cheapest world to generate; its voxels are replaced
  world.voxels = sites.map(([x, y, z]) => ({ x, y, z, color: '#808080', type: 3 }))
  return world
}

describe('buildVoxelMesh', () => {
  it('emits only faces not covered by a neighbour', () => {
    expect(buildVoxelMesh(worldOf([[0, 0, 0]])).faceCount).toBe(12)
    // Nearest neighbours share a face; (2, 0, 0) is not one.
    expect(buildVoxelMesh(worldOf([[0, 0, 0], [1, 1, 0]])).faceCount).toBe(22)
    expect(buildVoxelMesh(worldOf([[0, 0, 0], [2, 0, 0]])).faceCount).toBe(24)
  })

  it('places voxel (x, y, z) at (x, y, -z) ± 1, as a rhombic dodecahedron', () => {
    const { positions } = buildVoxelMesh(worldOf([[2, 4, 6]]))
    const axis = (i: number) => positions.filter((_, j) => j % 3 === i)
    expect([Math.min(...axis(0)), Math.max(...axis(0))]).toEqual([1, 3])
    expect([Math.min(...axis(1)), Math.max(...axis(1))]).toEqual([3, 5])
    expect([Math.min(...axis(2)), Math.max(...axis(2))]).toEqual([-7, -5])
    for (let v = 0; v < positions.length; v += 3) {
      const [x, y, z] = [positions[v] - 2, positions[v + 1] - 4, -positions[v + 2] - 6]
      expect(Math.max(Math.abs(x) + Math.abs(y), Math.abs(y) + Math.abs(z), Math.abs(x) + Math.abs(z))).toBe(1)
    }
  })

  it('winds every triangle counter-clockwise seen from outside', () => {
    const { positions, indices } = buildVoxelMesh(worldOf([[0, 0, 0]]))
    const vertex = (i: number) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]].map(vertex)
      const u = b.map((v, k) => v - a[k])
      const w = c.map((v, k) => v - a[k])
      const normal = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
      // Outward: same direction as the triangle's centroid seen from the voxel's centre (the origin).
      const centroid = [0, 1, 2].map(k => (a[k] + b[k] + c[k]) / 3)
      expect(normal.reduce((sum, n, k) => sum + n * centroid[k], 0)).toBeGreaterThan(0)
    }
  })
})
