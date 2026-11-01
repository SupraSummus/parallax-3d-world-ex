import { describe, it, expect } from 'vitest'
import { FACES } from './view'
import { LayerIndex, VoxelGrid, isSite } from './voxel-grid'
import { World } from './world'

const { grid, voxels } = new World(7, 'hills_with_trees')

describe('VoxelGrid', () => {
  it('stores the sites of its box, one per pair of x, and nothing else', () => {
    const box = new VoxelGrid({ minX: -3, minY: 0, minZ: 0, maxX: 4, maxY: 3, maxZ: 2 }, [])
    // Widened to start and end on an even x.
    expect([box.minX, box.nx]).toEqual([-4, 8])
    const indices = new Set<number>()
    for (let z = 0; z < 2; z++) {
      for (let y = 0; y < 3; y++) {
        for (let x = -4; x < 4; x++) {
          const i = box.index(x, y, z)
          expect(i >= 0).toBe(isSite(x, y, z))
          if (i >= 0) indices.add(i)
        }
      }
    }
    expect(indices.size).toBe(box.cells.length)
    expect(Math.max(...indices)).toBe(box.cells.length - 1)
  })

  it('round-trips voxels, and refuses points that are not sites', () => {
    const list = [{ x: 0, y: 0, z: 0, color: '#ff0000', type: 1 }, { x: 3, y: -1, z: 2, color: '#00ff00', type: 2 }]
    expect(VoxelGrid.fromVoxels(list).toVoxels()).toEqual(list)
    expect(() => VoxelGrid.fromVoxels([{ x: 1, y: 0, z: 0, color: '#ff0000', type: 1 }])).toThrow(RangeError)
  })
})

const dot = (p: { x: number; y: number; z: number }, v: { x: number; y: number; z: number }) => p.x * v.x + p.y * v.y + p.z * v.z

describe('LayerIndex', () => {
  const index = new LayerIndex(grid, FACES.map(f => f.lattice))
  const along = (p: { x: number; y: number; z: number }, face: (typeof FACES)[number]) =>
    ({ a: dot(p, face.lattice.right), b: dot(p, face.lattice.up), c: dot(p, face.lattice.forward) })

  it('counts the voxels of a slice of layers', () => {
    for (const face of FACES) {
      for (const [from, to] of [[-3, 5], [0, 64], [-100, -40], [-1000, 1000], [7, 3]]) {
        const inSlice = voxels.filter(v => { const c = dot(v, face.lattice.forward); return c >= from && c < to })
        expect(index.count(face.lattice, from, to)).toBe(inSlice.length)
      }
    }
  })

  it('bounds b of the voxels in a box of layers and columns, by whole blocks of columns', () => {
    let [some, none] = [0, 0]
    let seed = 3
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    for (const face of FACES) {
      const placed = voxels.map(v => along(v, face))
      for (let n = 0; n < 40; n++) {
        const [c0, a0] = [Math.floor(random() * 300) - 150, Math.floor(random() * 300) - 150]
        const [c1, a1] = [c0 + 1 + Math.floor(random() * 40), a0 + 1 + Math.floor(random() * 60)]
        const range = index.range(face.lattice, c0, c1, a0, a1)
        const inBox = placed.filter(({ a, c }) => c >= c0 && c < c1 && a >= a0 && a < a1).map(p => p.b)
        // Whole blocks: some voxels a little outside [a0, a1) may count, never ones of other layers.
        const near = placed.filter(({ a, c }) => c >= c0 && c < c1 && a >= a0 - 8 && a < a1 + 8).map(p => p.b)
        if (inBox.length === 0 && !range) { none++; continue }
        expect(range).not.toBeNull()
        if (!range) continue
        some++
        expect(range[0]).toBeLessThanOrEqual(Math.min(...inBox))
        expect(range[1]).toBeGreaterThanOrEqual(Math.max(...inBox))
        expect(range[0]).toBeGreaterThanOrEqual(Math.min(...near))
        expect(range[1]).toBeLessThanOrEqual(Math.max(...near))
      }
    }
    expect(some).toBeGreaterThan(20)
    expect(none).toBeGreaterThan(20)
  })
})
