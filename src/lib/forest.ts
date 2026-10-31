import type { Material, Vec3, Voxel } from './world'

/**
 * Metres per voxel. Terrain and plant sizes below are in metres, converted
 * with vox(), so the scene keeps its proportions if this changes.
 */
export const VOXEL_SIZE = 0.5
const vox = (metres: number) => Math.round(metres / VOXEL_SIZE)

// Extent in voxels: 96 m wide, 160 m deep, heights from -8 m to 64 m.
const MIN_X = vox(-48)
const MAX_X = vox(48)
const MIN_Z = vox(-32)
const MAX_Z = vox(128)
const MIN_Y = vox(-8)
const MAX_Y = vox(64)
const NX = MAX_X - MIN_X
const NY = MAX_Y - MIN_Y
const NZ = MAX_Z - MIN_Z

// Material kinds; each voxel gets one shade of its kind, picked by position.
// `type` ids follow world.ts: 1 grass, 2 dirt, 3 stone, 4 wood, 5 leaves, 6 flower.
const KINDS = {
  moss: { type: 1, colors: ['#4f7a2a', '#5a8a30', '#466e26', '#628f37'] },
  grass: { type: 1, colors: ['#74a83c', '#7fb544', '#6a9c36'] },
  tallGrass: { type: 1, colors: ['#8fbf4d', '#9cc95a', '#a3b84a'] },
  litter: { type: 2, colors: ['#8a5a2b', '#9c6b30', '#7a4e24', '#a8763a'] },
  needles: { type: 2, colors: ['#6b4a2e', '#5e4029', '#76533a'] },
  path: { type: 2, colors: ['#a08262', '#957656', '#ab8c6b'] },
  soil: { type: 2, colors: ['#4a3423', '#3f2c1e', '#54392a'] },
  stone: { type: 3, colors: ['#7d7d78', '#6e6e6a', '#8a8a84'] },
  mossyStone: { type: 3, colors: ['#5f7348', '#687c4f', '#56693f'] },
  bark: { type: 4, colors: ['#4b3621', '#3f2d1c', '#57402a'] },
  spruceBark: { type: 4, colors: ['#4a3426', '#5a4030'] },
  birchBark: { type: 4, colors: ['#e6e2d6', '#dcd7c9', '#efece4'] },
  birchMark: { type: 4, colors: ['#2e2b28', '#3b3733'] },
  deadwood: { type: 4, colors: ['#6a5640', '#5c4a36', '#776149'] },
  spruce: { type: 5, colors: ['#1f4a2c', '#24553a', '#1a3f26', '#2b5e3c'] },
  oakGreen: { type: 5, colors: ['#4c7f2a', '#5a8f30', '#447324', '#679a38'] },
  oakOrange: { type: 5, colors: ['#c46a1c', '#d68526', '#b0521a', '#9c4a1c'] },
  oakGold: { type: 5, colors: ['#d9a521', '#c8941c', '#e3b53a', '#b88a1e'] },
  birchGreen: { type: 5, colors: ['#7fae3c', '#8cbc45', '#9ac24f'] },
  birchGold: { type: 5, colors: ['#d8cf4a', '#e6d65a', '#c9be36', '#efe07a'] },
  fern: { type: 5, colors: ['#3f7a2c', '#4a8a34', '#56953a'] },
  bracken: { type: 5, colors: ['#a8642a', '#b97a35', '#8f5524'] },
  bush: { type: 5, colors: ['#3d6b28', '#477a2e', '#355f22'] },
  flower: { type: 6, colors: ['#e8d34a', '#c9b1ff', '#f2f2f2', '#e86a6a'] },
} satisfies Record<string, { type: number; colors: string[] }>
type Kind = keyof typeof KINDS

const MATERIALS: Material[] = [{ color: '', type: 0 }] // index 0 = empty
const KIND_MATERIALS = {} as Record<Kind, number[]>
for (const [kind, { type, colors }] of Object.entries(KINDS) as [Kind, (typeof KINDS)[Kind]][]) {
  KIND_MATERIALS[kind] = colors.map(color => MATERIALS.push({ color, type }) - 1)
}
const LEAVES_TYPE = 5

// ---------------------------------------------------------------------------
// Noise and randomness

/** Integer hash of a lattice point to [0, 1). */
function hash(seed: number, x: number, y: number, z = 0): number {
  let h = (seed | 0) + Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1440662683)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** Smoothly interpolated lattice noise in [0, 1). */
function valueNoise(seed: number, x: number, y: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const u = fx * fx * (3 - 2 * fx)
  const v = fy * fy * (3 - 2 * fy)
  const a = hash(seed, ix, iy)
  const b = hash(seed, ix + 1, iy)
  const c = hash(seed, ix, iy + 1)
  const d = hash(seed, ix + 1, iy + 1)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

/** Fractal (multi-octave) value noise in [0, 1). */
function fbm(seed: number, x: number, y: number, octaves = 4): number {
  let sum = 0
  let amplitude = 1
  let total = 0
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(seed + i * 7919, x, y) * amplitude
    total += amplitude
    amplitude /= 2
    x *= 2
    y *= 2
  }
  return sum / total
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** Seeded PRNG (mulberry32) returning [0, 1). */
function rng(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// Voxel grid

/** Dense material grid used while generating; converted to Voxels at the end. */
class Grid {
  readonly cells = new Uint8Array(NX * NY * NZ)
  constructor(private readonly shadeSeed: number) {}

  private index(x: number, y: number, z: number): number {
    if (x < MIN_X || x >= MAX_X || y < MIN_Y || y >= MAX_Y || z < MIN_Z || z >= MAX_Z) return -1
    return ((x - MIN_X) * NZ + (z - MIN_Z)) * NY + (y - MIN_Y)
  }

  get(x: number, y: number, z: number): number {
    const i = this.index(x, y, z)
    return i < 0 ? 0 : this.cells[i]
  }

  /** Places a shade of `kind`; keeps an existing voxel unless `replace`. Out-of-range cells are ignored. */
  put(x: number, y: number, z: number, kind: Kind, replace = false) {
    const i = this.index(x, y, z)
    if (i < 0 || (!replace && this.cells[i] !== 0)) return
    const shades = KIND_MATERIALS[kind]
    this.cells[i] = shades[Math.floor(hash(this.shadeSeed, x, y, z) * shades.length)]
  }

  /** Fills a ball, keeping each cell with probability `fill`. */
  ball(cx: number, cy: number, cz: number, radius: number, kind: Kind, fill: number, random: () => number) {
    const r = Math.ceil(radius)
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          if (dx * dx + dy * dy + dz * dz <= radius * radius && random() < fill) {
            this.put(Math.round(cx + dx), Math.round(cy + dy), Math.round(cz + dz), kind)
          }
        }
      }
    }
  }

  /** Draws a 1-voxel line (branches, fallen logs). */
  line(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, kind: Kind) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), 1)
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      this.put(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), Math.round(z0 + (z1 - z0) * t), kind, true)
    }
  }
}

// ---------------------------------------------------------------------------
// Generator

interface Column {
  height: number
  surface: Kind
  /** 0 = broadleaf, 1 = conifer. */
  conifer: number
  /** Tree density in [0, 1]; low in clearings. */
  density: number
  onPath: boolean
}

/**
 * An autumn forest valley: a winding path along the valley floor, wooded
 * slopes rising on both sides, and a ridge closing the view at the far end.
 * Spruce, birch and oak, with ferns, bushes, boulders and fallen logs.
 */
export function generateForest(seed: number): { voxels: Voxel[]; spawn: Vec3 } {
  const s = (k: number) => (seed | 0) + k * 1013904223
  const pathPhase = hash(s(1), 0, 0) * 100
  /** Path centre line, in metres. */
  const pathX = (zm: number) => 9 * Math.sin(zm / 31 + pathPhase) + 5 * Math.sin(zm / 13 + pathPhase * 2)

  const groundMetres = (xm: number, zm: number) => {
    const fromPath = Math.abs(xm - pathX(zm))
    const hills = (fbm(s(2), xm / 45, zm / 45) - 0.5) * 10 + (valueNoise(s(3), xm / 6, zm / 6) - 0.5) * 0.8
    const valley = smoothstep(8, 42, fromPath) * 18
    const ridge = smoothstep(95, 128, zm) * 22
    const pathDip = (1 - smoothstep(1, 2.2, fromPath)) * 0.3
    return hills + valley + ridge - pathDip
  }
  /** Ground height in voxels; also defined outside the extent. */
  const ground = (x: number, z: number) => vox(groundMetres(x * VOXEL_SIZE, z * VOXEL_SIZE))

  const grid = new Grid(s(4))
  const columns: Column[] = new Array<Column>(NX * NZ)
  const column = (x: number, z: number) => columns[(x - MIN_X) * NZ + (z - MIN_Z)]

  // Terrain.
  for (let x = MIN_X; x < MAX_X; x++) {
    for (let z = MIN_Z; z < MAX_Z; z++) {
      const xm = x * VOXEL_SIZE
      const zm = z * VOXEL_SIZE
      const h = ground(x, z)
      const neighbours = [ground(x - 1, z), ground(x + 1, z), ground(x, z - 1), ground(x, z + 1)]
      const slope = Math.max(...neighbours.map(n => Math.abs(n - h)))
      const conifer = smoothstep(0.4, 0.6, fbm(s(5), xm / 40, zm / 40)) * 0.75 + smoothstep(6, 16, h * VOXEL_SIZE) * 0.25
      const density = smoothstep(0.3, 0.48, fbm(s(6), xm / 22, zm / 22))
      const onPath = Math.abs(xm - pathX(zm)) < 1.1 + valueNoise(s(7), zm / 3, 0) * 0.5
      const floor = valueNoise(s(8), xm / 2.5, zm / 2.5)

      let surface: Kind
      if (onPath) surface = 'path'
      else if (slope >= 3) surface = floor < 0.5 ? 'stone' : 'mossyStone'
      else if (density < 0.2) surface = floor < 0.75 ? 'grass' : 'moss'
      else if (conifer > 0.5) surface = floor < 0.55 ? 'needles' : 'moss'
      else surface = floor < 0.6 ? 'litter' : 'moss'
      columns[(x - MIN_X) * NZ + (z - MIN_Z)] = { height: h, surface, conifer, density, onPath }

      // Fill deep enough that no gaps open between slices or on slopes.
      const bottom = Math.min(h - 3, ...neighbours)
      const rock = surface === 'stone' || surface === 'mossyStone'
      for (let y = bottom; y <= h; y++) {
        grid.put(x, y, z, y >= h - 1 ? surface : rock ? 'stone' : 'soil')
      }
    }
  }

  // Start on the path at the near end, at about the height of a tall shrub.
  const spawnZ = MIN_Z + 2
  const spawnX = Math.round(pathX(spawnZ * VOXEL_SIZE) / VOXEL_SIZE)
  const spawn = { x: spawnX, y: column(spawnX, spawnZ).height + vox(3), z: spawnZ }

  const random = rng(s(9))

  // Trees on a jittered grid.
  const cell = vox(4)
  for (let cx = MIN_X; cx < MAX_X; cx += cell) {
    for (let cz = MIN_Z; cz < MAX_Z; cz += cell) {
      const x = cx + Math.floor(random() * cell)
      const z = cz + Math.floor(random() * cell)
      if (x >= MAX_X || z >= MAX_Z) continue
      const c = column(x, z)
      if (random() > 0.15 + c.density * 0.75 || c.surface === 'stone') continue
      if (Math.abs(x * VOXEL_SIZE - pathX(z * VOXEL_SIZE)) < 2.8) continue
      // Keep the view from the spawn point clear of low branches.
      if (Math.hypot(x - spawn.x, z - spawn.z) < vox(7)) continue
      const species = random()
      const treeRandom = rng(s(10) + x * 7349 + z * 15731)
      if (species < c.conifer) spruceTree(grid, x, c.height, z, treeRandom)
      else if (species < c.conifer + (1 - c.conifer) * 0.45) birchTree(grid, x, c.height, z, treeRandom)
      else oakTree(grid, x, c.height, z, treeRandom)
    }
  }

  // Undergrowth, boulders and fallen logs.
  for (let x = MIN_X; x < MAX_X; x++) {
    for (let z = MIN_Z; z < MAX_Z; z++) {
      const c = column(x, z)
      const y = c.height + 1
      const roll = random()
      if (roll < 0.0006) boulder(grid, x, c.height, z, random)
      else if (roll < 0.0009 && !c.onPath) fallenLog(grid, x, z, ground, random)
      if (c.onPath || grid.get(x, y, z) !== 0) continue
      const r = random()
      if (c.surface === 'grass') {
        if (r < 0.08) grid.put(x, y, z, 'tallGrass')
        else if (r < 0.11) grid.put(x, y, z, 'flower')
      } else if (c.surface !== 'stone' && c.surface !== 'mossyStone') {
        if (r < 0.025) fern(grid, x, y, z, c.conifer > 0.5 ? 'fern' : 'bracken', random)
        else if (r < 0.032) grid.ball(x, y, z, vox(0.5 + random() * 0.5), 'bush', 0.8, random)
        else if (r < 0.034) grid.put(x, y, z, 'flower')
      }
    }
  }

  // Emit voxels, dropping leaves enclosed on all six sides to save memory
  // (where a slice cuts through a crown, the leaves behind look the same).
  const voxels: Voxel[] = []
  const filled = (x: number, y: number, z: number) => grid.get(x, y, z) !== 0
  for (let z = MIN_Z; z < MAX_Z; z++) {
    for (let x = MIN_X; x < MAX_X; x++) {
      for (let y = MIN_Y; y < MAX_Y; y++) {
        const id = grid.get(x, y, z)
        if (id === 0) continue
        const { color, type } = MATERIALS[id]
        if (
          type === LEAVES_TYPE &&
          filled(x - 1, y, z) && filled(x + 1, y, z) &&
          filled(x, y - 1, z) && filled(x, y + 1, z) &&
          filled(x, y, z - 1) && filled(x, y, z + 1)
        ) continue
        voxels.push({ x, y, z, color, type })
      }
    }
  }

  return { voxels, spawn }
}

/** A vertical trunk, `width` voxels square, from just below `ground` up to `top`. */
function trunk(grid: Grid, x: number, ground: number, z: number, top: number, width: number, kind: Kind) {
  for (let y = ground - 1; y <= top; y++) {
    for (let dx = 0; dx < width; dx++) {
      for (let dz = 0; dz < width; dz++) grid.put(x + dx, y, z + dz, kind, true)
    }
  }
}

/** Conical spruce with drooping whorls of branches. */
function spruceTree(grid: Grid, x: number, ground: number, z: number, random: () => number) {
  const height = vox(14 + random() * 10)
  const width = height >= vox(20) ? 2 : 1
  const top = ground + height
  trunk(grid, x, ground, z, top - 2, width, 'spruceBark')
  const base = ground + Math.round(height * (0.15 + random() * 0.15))
  const radius = height * (0.17 + random() * 0.05)
  const whorl = vox(1.5 + random() * 0.6)
  const centre = (width - 1) / 2
  for (let y = base; y <= top + 1; y++) {
    const t = (y - base) / (top + 1 - base)
    // Each whorl is widest at its bottom, giving the layered silhouette.
    const phase = ((top - y) % whorl) / whorl
    const r = radius * (1 - t) * (0.5 + 0.5 * phase) + 0.7
    const ri = Math.ceil(r)
    for (let dx = -ri; dx <= ri + width - 1; dx++) {
      for (let dz = -ri; dz <= ri + width - 1; dz++) {
        const d = Math.hypot(dx - centre, dz - centre)
        if (d <= r && random() < 0.95 - 0.35 * (d / r) ** 3) grid.put(x + dx, y, z + dz, 'spruce')
      }
    }
  }
}

/** Slender white birch with a wavy trunk and a loose, clumpy crown. */
function birchTree(grid: Grid, x: number, ground: number, z: number, random: () => number) {
  const height = vox(12 + random() * 7)
  let tx = x
  let tz = z
  for (let y = ground - 1; y <= ground + height; y++) {
    if ((y - ground) % vox(3) === 0 && y - ground > vox(4) && random() < 0.35) {
      if (random() < 0.5) tx += random() < 0.5 ? -1 : 1
      else tz += random() < 0.5 ? -1 : 1
    }
    grid.put(tx, y, tz, random() < 0.18 ? 'birchMark' : 'birchBark', true)
  }
  const foliage: Kind = random() < 0.65 ? 'birchGold' : 'birchGreen'
  const crownBottom = ground + height * 0.45
  const crownTop = ground + height + vox(1)
  const cy = (crownBottom + crownTop) / 2
  const ry = (crownTop - crownBottom) / 2
  const rx = vox(2 + random() * 1.2)
  const clusters = 12 + Math.floor(random() * 6)
  for (let i = 0; i < clusters; i++) {
    // Uniform point in the crown ellipsoid.
    let ox, oy, oz
    do {
      ox = random() * 2 - 1
      oy = random() * 2 - 1
      oz = random() * 2 - 1
    } while (ox * ox + oy * oy + oz * oz > 1)
    const px = tx + ox * rx
    const py = cy + oy * ry
    const pz = tz + oz * rx
    grid.line(tx, Math.round(py - 1), tz, Math.round(px), Math.round(py), Math.round(pz), 'birchBark')
    grid.ball(px, py, pz, vox(0.8 + random() * 0.6), foliage, 0.7, random)
  }
}

/** Broad oak: thick trunk, a few branches each ending in a leaf cluster. */
function oakTree(grid: Grid, x: number, ground: number, z: number, random: () => number) {
  const height = vox(12 + random() * 8)
  const trunkTop = ground + Math.round(height * (0.45 + random() * 0.1))
  trunk(grid, x, ground, z, trunkTop, 2, 'bark')
  const roll = random()
  const foliage: Kind = roll < 0.45 ? 'oakGreen' : roll < 0.75 ? 'oakOrange' : 'oakGold'
  const cx = x + 0.5
  const cz = z + 0.5
  const branches = 4 + Math.floor(random() * 3)
  const ends: [number, number, number][] = [[cx, ground + height - vox(2), cz]]
  for (let i = 0; i < branches; i++) {
    const angle = (i / branches) * Math.PI * 2 + random() * 0.8
    const reach = vox(2.5 + random() * 2.5)
    const startY = trunkTop - Math.floor(random() * vox(2))
    const end: [number, number, number] = [
      cx + Math.cos(angle) * reach,
      Math.min(startY + vox(2 + random() * 3), ground + height - vox(1.5)),
      cz + Math.sin(angle) * reach,
    ]
    grid.line(Math.round(cx), startY, Math.round(cz), Math.round(end[0]), Math.round(end[1]), Math.round(end[2]), 'bark')
    ends.push(end)
  }
  for (const [ex, ey, ez] of ends) {
    grid.ball(ex, ey, ez, vox(1.8 + random() * 1.2), foliage, 0.8, random)
  }
}

/** A fern or bracken clump about a metre across. */
function fern(grid: Grid, x: number, y: number, z: number, kind: Kind, random: () => number) {
  grid.put(x, y, z, kind)
  if (random() < 0.5) grid.put(x, y + 1, z, kind)
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (random() < 0.6) grid.put(x + dx, y, z + dz, kind)
  }
}

/** A half-buried rock with moss on its upper side. */
function boulder(grid: Grid, x: number, ground: number, z: number, random: () => number) {
  const rx = vox(0.8 + random() * 1.4)
  const ry = rx * (0.6 + random() * 0.3)
  const rz = vox(0.8 + random() * 1.4)
  for (let dx = -rx; dx <= rx; dx++) {
    for (let dz = -rz; dz <= rz; dz++) {
      for (let dy = -Math.ceil(ry); dy <= Math.ceil(ry); dy++) {
        const d = (dx / rx) ** 2 + (dy / ry) ** 2 + (dz / rz) ** 2
        if (d > 1) continue
        grid.put(x + dx, ground + dy, z + dz, dy > ry * 0.4 && random() < 0.7 ? 'mossyStone' : 'stone', true)
      }
    }
  }
}

/** A fallen trunk lying across the ground, with moss on top. */
function fallenLog(
  grid: Grid,
  x: number,
  z: number,
  ground: (x: number, z: number) => number,
  random: () => number,
) {
  const length = vox(4 + random() * 5)
  const angle = random() * Math.PI
  const dx = Math.cos(angle)
  const dz = Math.sin(angle)
  for (let i = 0; i <= length; i++) {
    const px = Math.round(x + dx * i)
    const pz = Math.round(z + dz * i)
    const y = ground(px, pz) + 1
    grid.put(px, y, pz, 'deadwood', true)
    if (random() < 0.5) grid.put(px, y + 1, pz, 'moss')
  }
}
