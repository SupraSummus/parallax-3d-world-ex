import type { Vec3 } from './world'
import { VOXEL_FACES } from './fcc'
import { VoxelGrid, isSite, type Material } from './voxel-grid'
import { fbm, hash, rng, smoothstep, valueNoise } from './noise'

/**
 * Metres per lattice unit: voxels are FCC sites (voxel-grid.ts), nearest
 * neighbours √2 units (0.35 m) apart. Terrain and plant sizes below are in
 * metres, converted with vox(), so the scene keeps its proportions if this
 * changes. Shapes (the ground's height, trunks, balls, branches) are
 * sampled at the lattice's sites.
 * @internal
 */
export const UNIT_SIZE = 0.25
const vox = (metres: number) => Math.round(metres / UNIT_SIZE)
/** Radius of branches and fallen logs, in units: thick enough to stay one piece on the lattice. */
const BRANCH_RADIUS = 0.3 / UNIT_SIZE

// Extent in units: 96 m wide, 160 m deep, heights from -8 m to 64 m.
const MIN_X = vox(-48)
const MAX_X = vox(48)
const MIN_Z = vox(-32)
const MAX_Z = vox(128)
const MIN_Y = vox(-8)
const MAX_Y = vox(64)
const NX = MAX_X - MIN_X
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
// Voxel grid

/** The world's voxel grid, with placement helpers that pick a shade of a kind. */
class Grid {
  readonly voxels = new VoxelGrid(
    { minX: MIN_X, minY: MIN_Y, minZ: MIN_Z, maxX: MAX_X, maxY: MAX_Y, maxZ: MAX_Z },
    MATERIALS,
  )
  constructor(private readonly shadeSeed: number) {}

  get(x: number, y: number, z: number): number {
    return this.voxels.get(x, y, z)
  }

  /** Places a shade of `kind` at a site; keeps an existing voxel unless `replace`. Points that are not sites, or out of range, are ignored. */
  put(x: number, y: number, z: number, kind: Kind, replace = false) {
    const i = this.voxels.index(x, y, z)
    const { cells } = this.voxels
    if (i < 0 || (!replace && cells[i] !== 0)) return
    const shades = KIND_MATERIALS[kind]
    cells[i] = shades[Math.floor(hash(this.shadeSeed, x, y, z) * shades.length)]
  }

  /** Fills the sites in a ball, keeping each with probability `fill`. */
  ball(cx: number, cy: number, cz: number, radius: number, kind: Kind, fill: number, random: () => number) {
    const r2 = radius * radius
    for (let y = Math.ceil(cy - radius); y <= cy + radius; y++) {
      for (let z = Math.ceil(cz - radius); z <= cz + radius; z++) {
        const rest = r2 - (y - cy) ** 2 - (z - cz) ** 2
        if (rest < 0) continue
        const half = Math.sqrt(rest)
        const x0 = Math.ceil(cx - half)
        // Sites only: x + y + z even.
        for (let x = x0 + ((x0 + y + z) & 1); x <= cx + half; x += 2) {
          if (random() < fill) this.put(x, y, z, kind)
        }
      }
    }
  }

  /** Fills the sites within `radius` of the segment from p to q (branches, fallen logs). */
  capsule(px: number, py: number, pz: number, qx: number, qy: number, qz: number, radius: number, kind: Kind) {
    const [dx, dy, dz] = [qx - px, qy - py, qz - pz]
    const length2 = dx * dx + dy * dy + dz * dz
    for (let x = Math.ceil(Math.min(px, qx) - radius); x <= Math.max(px, qx) + radius; x++) {
      for (let y = Math.ceil(Math.min(py, qy) - radius); y <= Math.max(py, qy) + radius; y++) {
        for (let z = Math.ceil(Math.min(pz, qz) - radius); z <= Math.max(pz, qz) + radius; z++) {
          if (!isSite(x, y, z)) continue
          const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - px) * dx + (y - py) * dy + (z - pz) * dz) / length2))
          if ((x - px - t * dx) ** 2 + (y - py - t * dy) ** 2 + (z - pz - t * dz) ** 2 <= radius * radius) this.put(x, y, z, kind, true)
        }
      }
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
export function generateForest(seed: number): { grid: VoxelGrid; spawn: Vec3 } {
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
  // Ground heights of the extent and a border of one unit around it, computed once.
  const heights = new Int32Array((NX + 2) * (NZ + 2))
  for (let x = MIN_X - 1; x <= MAX_X; x++) {
    for (let z = MIN_Z - 1; z <= MAX_Z; z++) heights[(x - MIN_X + 1) * (NZ + 2) + z - MIN_Z + 1] = vox(groundMetres(x * UNIT_SIZE, z * UNIT_SIZE))
  }
  /** Ground height in units; also defined outside the extent. */
  const ground = (x: number, z: number) =>
    x >= MIN_X - 1 && x <= MAX_X && z >= MIN_Z - 1 && z <= MAX_Z
      ? heights[(x - MIN_X + 1) * (NZ + 2) + z - MIN_Z + 1]
      : vox(groundMetres(x * UNIT_SIZE, z * UNIT_SIZE))

  const grid = new Grid(s(4))
  const columns: Column[] = new Array<Column>(NX * NZ)
  const column = (x: number, z: number) => columns[(x - MIN_X) * NZ + (z - MIN_Z)]

  // Terrain.
  for (let x = MIN_X; x < MAX_X; x++) {
    for (let z = MIN_Z; z < MAX_Z; z++) {
      const xm = x * UNIT_SIZE
      const zm = z * UNIT_SIZE
      const h = ground(x, z)
      const neighbours = [ground(x - 1, z), ground(x + 1, z), ground(x, z - 1), ground(x, z + 1)]
      const slope = Math.max(...neighbours.map(n => Math.abs(n - h)))
      const conifer = smoothstep(0.4, 0.6, fbm(s(5), xm / 40, zm / 40)) * 0.75 + smoothstep(6, 16, h * UNIT_SIZE) * 0.25
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
      const bottom = Math.min(h - vox(1.5), ...neighbours)
      const rock = surface === 'stone' || surface === 'mossyStone'
      for (let y = bottom + ((x + bottom + z) & 1); y <= h; y += 2) {
        grid.put(x, y, z, y > h - vox(1) ? surface : rock ? 'stone' : 'soil')
      }
    }
  }

  // Start on the path at the near end, at about the height of a tall shrub.
  const spawnZ = MIN_Z + vox(1)
  const spawnX = Math.round(pathX(spawnZ * UNIT_SIZE) / UNIT_SIZE)
  // On a site, so it is in a voxel's cell, which is empty.
  const spawnY = column(spawnX, spawnZ).height + vox(3)
  const spawn = { x: spawnX, y: spawnY + ((spawnX + spawnY + spawnZ) & 1), z: spawnZ }

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
      if (Math.abs(x * UNIT_SIZE - pathX(z * UNIT_SIZE)) < 2.8) continue
      // Keep the view from the spawn point clear of low branches.
      if (Math.hypot(x - spawn.x, z - spawn.z) < vox(7)) continue
      const species = random()
      const treeRandom = rng(s(10) + x * 7349 + z * 15731)
      if (species < c.conifer) spruceTree(grid, x, c.height, z, treeRandom)
      else if (species < c.conifer + (1 - c.conifer) * 0.45) birchTree(grid, x, c.height, z, treeRandom)
      else oakTree(grid, x, c.height, z, treeRandom)
    }
  }

  // Undergrowth, boulders and fallen logs, per column of units: (0.25 m)².
  for (let x = MIN_X; x < MAX_X; x++) {
    for (let z = MIN_Z; z < MAX_Z; z++) {
      const c = column(x, z)
      const y = c.height + 1
      const roll = random()
      if (roll < 0.00015) boulder(grid, x, c.height, z, random)
      else if (roll < 0.000225 && !c.onPath) fallenLog(grid, x, z, ground, random)
      if (c.onPath || grid.get(x, y, z) !== 0 || !isSite(x, y, z)) continue
      const r = random()
      if (c.surface === 'grass') {
        if (r < 0.04) grid.put(x, y, z, 'tallGrass')
        else if (r < 0.055) grid.put(x, y, z, 'flower')
      } else if (c.surface !== 'stone' && c.surface !== 'mossyStone') {
        if (r < 0.0125) fern(grid, x, y, z, c.conifer > 0.5 ? 'fern' : 'bracken', random)
        else if (r < 0.016) grid.ball(x, y, z, vox(0.5 + random() * 0.5), 'bush', 0.8, random)
        else if (r < 0.017) grid.put(x, y, z, 'flower')
      }
    }
  }

  // Drop leaves enclosed on all twelve sides: crowns become shells, which
  // keeps the reference viewer's voxel count down.
  const { voxels } = grid
  const { cells, minX, minY, minZ, nx, ny, nz } = voxels
  const half = nx / 2
  const leaves = MATERIALS.map(m => m.type === LEAVES_TYPE)
  // A neighbour (a, b, c) of the site at index i, whose x - minX has parity p, is at i + offset[p][k].
  const offsets = [0, 1].map(p => VOXEL_FACES.map(({ normal: [a, b, c] }) => (c * ny + b) * half + ((p + a) >> 1)))
  const enclosed: number[] = []
  for (let z = minZ + 1; z < minZ + nz - 1; z++) {
    for (let y = minY + 1; y < minY + ny - 1; y++) {
      const row = ((z - minZ) * ny + (y - minY)) * half
      for (let x = minX + 2 + ((minX + y + z) & 1); x < minX + nx - 2; x += 2) {
        const i = row + ((x - minX) >> 1)
        if (!leaves[cells[i]]) continue
        if (offsets[(x - minX) & 1].every(o => cells[i + o] !== 0)) enclosed.push(i)
      }
    }
  }
  for (const i of enclosed) cells[i] = 0

  return { grid: voxels, spawn }
}

/** A vertical trunk, `width` units square (at least 2, to stay one piece on the lattice), from just below `ground` up to `top`. */
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
  const width = height >= vox(20) ? vox(1) : vox(0.5)
  const top = ground + height
  trunk(grid, x, ground, z, top - vox(1), width, 'spruceBark')
  const base = ground + Math.round(height * (0.15 + random() * 0.15))
  const radius = height * (0.17 + random() * 0.05)
  const whorl = vox(1.5 + random() * 0.6)
  const centre = (width - 1) / 2
  for (let y = base; y <= top + vox(0.5); y++) {
    const t = (y - base) / (top + vox(0.5) - base)
    // Each whorl is widest at its bottom, giving the layered silhouette.
    const phase = ((top - y) % whorl) / whorl
    const r = radius * (1 - t) * (0.5 + 0.5 * phase) + vox(0.35)
    const ri = Math.ceil(r)
    for (let dz = -ri; dz <= ri + width - 1; dz++) {
      // Sites only: x + y + z even.
      for (let dx = -ri + ((x - ri + y + z + dz) & 1); dx <= ri + width - 1; dx += 2) {
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
  let bark: Kind = 'birchBark'
  for (let y = ground - 1; y <= ground + height; y++) {
    if ((y - ground) % vox(3) === 0 && y - ground > vox(4) && random() < 0.35) {
      if (random() < 0.5) tx += random() < 0.5 ? -1 : 1
      else tz += random() < 0.5 ? -1 : 1
    }
    // Bark in bands half a metre tall, some with a black mark.
    if ((y - ground) % vox(0.5) === 0) bark = random() < 0.18 ? 'birchMark' : 'birchBark'
    // Two units square, so the trunk stays one piece on the lattice.
    for (let dx = 0; dx < 2; dx++) for (let dz = 0; dz < 2; dz++) grid.put(tx + dx, y, tz + dz, bark, true)
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
    grid.capsule(tx + 0.5, py - vox(0.5), tz + 0.5, px, py, pz, BRANCH_RADIUS, 'birchBark')
    grid.ball(px, py, pz, vox(0.8 + random() * 0.6), foliage, 0.7, random)
  }
}

/** Broad oak: thick trunk, a few branches each ending in a leaf cluster. */
function oakTree(grid: Grid, x: number, ground: number, z: number, random: () => number) {
  const height = vox(12 + random() * 8)
  const trunkTop = ground + Math.round(height * (0.45 + random() * 0.1))
  const width = vox(1)
  trunk(grid, x, ground, z, trunkTop, width, 'bark')
  const roll = random()
  const foliage: Kind = roll < 0.45 ? 'oakGreen' : roll < 0.75 ? 'oakOrange' : 'oakGold'
  const cx = x + (width - 1) / 2
  const cz = z + (width - 1) / 2
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
    grid.capsule(cx, startY, cz, end[0], end[1], end[2], BRANCH_RADIUS, 'bark')
    ends.push(end)
  }
  for (const [ex, ey, ez] of ends) {
    grid.ball(ex, ey, ez, vox(1.8 + random() * 1.2), foliage, 0.8, random)
  }
}

/** A fern or bracken clump about a metre across: fronds spreading from the middle. */
function fern(grid: Grid, x: number, y: number, z: number, kind: Kind, random: () => number) {
  grid.ball(x, y, z, 1.5, kind, 1, random)
  if (random() < 0.5) grid.ball(x, y + vox(0.5), z, 1.5, kind, 1, random)
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (random() < 0.6) grid.ball(x + dx * vox(0.5), y, z + dz * vox(0.5), 1.5, kind, 1, random)
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
  const [ex, ez] = [x + dx * length, z + dz * length]
  const lift = BRANCH_RADIUS * 1.5
  grid.capsule(x, ground(x, z) + lift, z, ex, ground(Math.round(ex), Math.round(ez)) + lift, ez, BRANCH_RADIUS * 1.5, 'deadwood')
  // Moss in patches on top.
  for (let i = 0; i <= length; i += vox(0.5)) {
    const px = Math.round(x + dx * i)
    const pz = Math.round(z + dz * i)
    if (random() < 0.5) grid.ball(px, ground(px, pz) + lift * 2 + 1, pz, 1.2, 'moss', 1, random)
  }
}
