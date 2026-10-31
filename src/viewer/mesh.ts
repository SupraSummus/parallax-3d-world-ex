import type { World } from '@/lib/world'

export interface VoxelMesh {
  /** xyz per vertex, in three.js space: (x, y, -z), so the default -z view looks along world +z. */
  positions: Float32Array
  /** rgb per vertex (0–255), with fixed per-face shading baked in. */
  colors: Uint8Array
  indices: Uint32Array
  faceCount: number
}

// For each face: the neighbour offset in world space, a brightness, and the
// four corners in three.js space (z already negated), counter-clockwise when
// seen from outside so back-face culling works.
const FACES: { dir: [number, number, number]; shade: number; corners: [number, number, number][] }[] = [
  { dir: [0, 1, 0], shade: 1, corners: [[0, 1, 0], [1, 1, 0], [1, 1, -1], [0, 1, -1]] },
  { dir: [0, -1, 0], shade: 0.55, corners: [[0, 0, 0], [0, 0, -1], [1, 0, -1], [1, 0, 0]] },
  { dir: [1, 0, 0], shade: 0.8, corners: [[1, 0, 0], [1, 0, -1], [1, 1, -1], [1, 1, 0]] },
  { dir: [-1, 0, 0], shade: 0.7, corners: [[0, 0, -1], [0, 0, 0], [0, 1, 0], [0, 1, -1]] },
  // World -z faces the parallax camera; in three.js space that is +z.
  { dir: [0, 0, -1], shade: 0.9, corners: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]] },
  { dir: [0, 0, 1], shade: 0.65, corners: [[1, 0, -1], [0, 0, -1], [0, 1, -1], [1, 1, -1]] },
]

/**
 * Builds a triangle mesh of every voxel face not covered by a neighbour.
 * Voxel (x, y, z) covers [x ± 0.5] × [y ± 0.5] × [z ± 0.5], as in the
 * parallax renderer.
 */
export function buildVoxelMesh(world: World): VoxelMesh {
  const faces: number[] = [] // voxel index * 8 + face index
  world.voxels.forEach((v, i) => {
    FACES.forEach(({ dir: [dx, dy, dz] }, f) => {
      if (!world.has(v.x + dx, v.y + dy, v.z + dz)) faces.push(i * 8 + f)
    })
  })

  const positions = new Float32Array(faces.length * 12)
  const colors = new Uint8Array(faces.length * 12)
  const indices = new Uint32Array(faces.length * 6)
  faces.forEach((packed, n) => {
    const v = world.voxels[Math.floor(packed / 8)]
    const { shade, corners } = FACES[packed % 8]
    const rgb = [1, 3, 5].map(i => Math.round(parseInt(v.color.slice(i, i + 2), 16) * shade))
    corners.forEach(([cx, cy, cz], k) => {
      const o = (n * 4 + k) * 3
      positions[o] = v.x - 0.5 + cx
      positions[o + 1] = v.y - 0.5 + cy
      positions[o + 2] = -(v.z - 0.5) + cz
      colors.set(rgb, o)
    })
    const base = n * 4
    indices.set([base, base + 1, base + 2, base, base + 2, base + 3], n * 6)
  })
  return { positions, colors, indices, faceCount: faces.length }
}
