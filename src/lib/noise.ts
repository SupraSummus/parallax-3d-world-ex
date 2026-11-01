// Deterministic noise and randomness shared by the world generators.

/** Integer hash of a lattice point to [0, 1). */
export function hash(seed: number, x: number, y: number, z = 0): number {
  let h = (seed | 0) + Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1440662683)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** Smoothly interpolated lattice noise in [0, 1). */
export function valueNoise(seed: number, x: number, y: number): number {
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
export function fbm(seed: number, x: number, y: number, octaves = 4): number {
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

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** Seeded PRNG (mulberry32) returning [0, 1). */
export function rng(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
