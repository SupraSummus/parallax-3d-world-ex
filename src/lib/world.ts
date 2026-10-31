export interface Voxel {
  x: number
  y: number
  z: number
  color: string
  type: number
}

export type WorldType = 'forest' | 'hills' | 'mountains' | 'hills_with_trees' | 'lake_with_island'

export const WORLD_TYPES: { value: WorldType; label: string }[] = [
  { value: 'forest', label: 'Forest' },
  { value: 'hills', label: 'Hills' },
  { value: 'mountains', label: 'Mountains' },
  { value: 'hills_with_trees', label: 'Hills with Trees' },
  { value: 'lake_with_island', label: 'Lake with Island' },
]

interface Material {
  color: string
  type: number
}

// `type` ids: 1 grass, 2 dirt, 3 stone, 4 wood, 5 leaves, 6 flower, 7 snow, 8 water, 9 sand
const GRASS: Material = { color: '#4CAF50', type: 1 }
const DIRT: Material = { color: '#8B4513', type: 2 }
const STONE: Material = { color: '#666666', type: 3 }
const LEAVES: Material = { color: '#228B22', type: 5 }
const WATER: Material = { color: '#1E90FF', type: 8 }
const FLOWER_COLORS = ['#FF6B6B', '#FFE66D', '#4ECDC4', '#C9B1FF']

/** The world spans x, z in [-HALF_SIZE, HALF_SIZE). */
const HALF_SIZE = 40
/** Every column is filled from this y up to its surface. */
const BEDROCK_Y = -5

/** A procedurally generated, immutable voxel world. */
export class World {
  voxels: Voxel[] = []
  readonly seed: number
  readonly worldType: WorldType

  constructor(seed: number = Date.now(), worldType: WorldType = 'forest') {
    this.seed = seed
    this.worldType = worldType

    for (let x = -HALF_SIZE; x < HALF_SIZE; x++) {
      for (let z = -HALF_SIZE; z < HALF_SIZE; z++) {
        this.generateColumn(x, z)
      }
    }
  }

  /** Voxels with world z in [minZ, maxZ). */
  getVoxelsInZRange(minZ: number, maxZ: number): Voxel[] {
    return this.voxels.filter(v => v.z >= minZ && v.z < maxZ)
  }

  /** Deterministic hash noise in [0, 1). */
  private noise(x: number, y: number, z: number): number {
    const n = Math.sin(x * 12.9898 + y * 78.233 + z * 45.164 + this.seed * 0.001) * 43758.5453
    return n - Math.floor(n)
  }

  private terrainHeight(x: number, z: number, heightMultiplier: number): number {
    const nx = (x / HALF_SIZE) * 4
    const nz = (z / HALF_SIZE) * 4
    return Math.floor(
      this.noise(nx, 0, nz) * 8 * heightMultiplier +
      this.noise(nx * 2, 0, nz * 2) * 4 * heightMultiplier +
      this.noise(nx * 4, 0, nz * 4) * 2 * heightMultiplier
    )
  }

  private push(x: number, y: number, z: number, material: Material) {
    this.voxels.push({ x, y, z, color: material.color, type: material.type })
  }

  /** Fills a column from bedrock to `top`: surface block, 2 subsoil blocks, rock below. */
  private soilColumn(x: number, z: number, top: number, surface: Material, subsoil = DIRT, rock = STONE) {
    for (let y = BEDROCK_Y; y <= top; y++) {
      this.push(x, y, z, y === top ? surface : y > top - 3 ? subsoil : rock)
    }
  }

  private tree(x: number, ground: number, z: number, height: number) {
    for (let y = ground + 1; y < ground + height; y++) {
      this.push(x, y, z, { color: '#654321', type: 4 })
    }
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dy = 0; dy < 3; dy++) {
          if (Math.abs(dx) + Math.abs(dz) + dy < 4) {
            this.push(x + dx, ground + height - 1 + dy, z + dz, LEAVES)
          }
        }
      }
    }
  }

  private palm(x: number, ground: number, z: number, height: number) {
    for (let y = ground + 1; y < ground + height; y++) {
      this.push(x, y, z, { color: '#8B7355', type: 4 })
    }
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (Math.abs(dx) + Math.abs(dz) <= 2) {
          this.push(x + dx, ground + height, z + dz, { color: '#32CD32', type: 5 })
        }
      }
    }
  }

  private generateColumn(x: number, z: number) {
    switch (this.worldType) {
      case 'forest': {
        const ground = this.terrainHeight(x, z, 1)
        this.soilColumn(x, z, ground, GRASS)
        if (this.noise(x * 0.3, 0, z * 0.3) > 0.6 && ground > 2) {
          this.tree(x, ground, z, 4 + Math.floor(this.noise(x, 0, z) * 3))
        }
        if (this.noise(x * 0.5, 50, z * 0.5) > 0.85) {
          this.push(x, ground + 1, z, { color: '#FFD700', type: 6 })
        }
        break
      }

      case 'hills': {
        const ground = this.terrainHeight(x, z, 0.7)
        this.soilColumn(x, z, ground, { color: '#7CFC00', type: 1 })
        if (this.noise(x * 0.4, 30, z * 0.4) > 0.8) {
          const color = FLOWER_COLORS[Math.floor(this.noise(x, z, 0) * FLOWER_COLORS.length)]
          this.push(x, ground + 1, z, { color, type: 6 })
        }
        break
      }

      case 'mountains': {
        const ground = this.terrainHeight(x, z, 2.5)
        for (let y = BEDROCK_Y; y <= ground; y++) {
          let material: Material
          if (y > 15) material = { color: '#FFFFFF', type: 7 }
          else if (y === ground && y > 8) material = { color: '#808080', type: 3 }
          else if (y === ground) material = GRASS
          else if (y > ground - 3) material = DIRT
          else material = { color: '#555555', type: 3 }
          this.push(x, y, z, material)
        }
        break
      }

      case 'hills_with_trees': {
        const ground = this.terrainHeight(x, z, 0.8)
        this.soilColumn(x, z, ground, GRASS)
        if (this.noise(x * 0.3, 0, z * 0.3) > 0.75 && ground > 2) {
          this.tree(x, ground, z, 4 + Math.floor(this.noise(x, 0, z) * 3))
        }
        break
      }

      case 'lake_with_island': {
        const ground = this.terrainHeight(x, z, 0.6)
        const distFromCenter = Math.sqrt(x * x + z * z)
        if (distFromCenter <= 8) {
          const top = ground + 3
          this.soilColumn(x, z, top, { color: '#90EE90', type: 1 }, { color: '#C4A76D', type: 2 })
          if (distFromCenter < 5 && this.noise(x * 0.5, 0, z * 0.5) > 0.7) {
            this.palm(x, top, z, 5 + Math.floor(this.noise(x, 0, z) * 2))
          }
        } else if (distFromCenter < 25) {
          this.soilColumn(x, z, 0, WATER, STONE)
        } else {
          const sand = { color: '#F4D03F', type: 9 }
          this.soilColumn(x, z, ground, distFromCenter < 28 ? sand : GRASS)
        }
        break
      }
    }
  }
}
