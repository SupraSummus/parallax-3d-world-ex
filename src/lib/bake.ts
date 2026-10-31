/**
 * Baking a chunk: which voxel faces a parallel projection along
 * (tanX, tanY, 1) reaches, where they land on the slice's centre plane, and
 * filling them into pixels. See DESIGN.md, section 3.
 */
import { bake } from './slice-selection'
import type { Voxel } from './world'

// Faces of a voxel, as bits of a mask.
export const FRONT = 1
export const LEFT = 2
export const RIGHT = 4
export const BOTTOM = 8
export const TOP = 16

/** Brightness of each face, shared with the reference viewer. */
export const FACE_SHADE = { front: 0.9, back: 0.65, left: 0.7, right: 0.8, bottom: 0.55, top: 1 }

/**
 * Faces of voxel `v` that no neighbour covers, as a mask. The front face
 * also counts as open on the slice's near plane (z = depth): the slice is
 * cut there, and the cut must show.
 */
export function openFaces(v: Voxel, depth: number, has: (x: number, y: number, z: number) => boolean): number {
  const { x, y, z } = v
  return (z === depth || !has(x, y, z - 1) ? FRONT : 0) |
    (has(x - 1, y, z) ? 0 : LEFT) |
    (has(x + 1, y, z) ? 0 : RIGHT) |
    (has(x, y - 1, z) ? 0 : BOTTOM) |
    (has(x, y + 1, z) ? 0 : TOP)
}

export interface SurfaceVoxel {
  voxel: Voxel
  /** See openFaces. */
  open: number
}

export interface BakedFace {
  voxel: Voxel
  shade: number
  /** Corners on the centre plane, in world x, y. */
  corners: [number, number][]
}

/**
 * The open faces a ray along (tanX, tanY, 1) can reach, baked onto the
 * plane z = centre, in painting order: far to near, and side faces before
 * the front face of the same z, which is nearer. A ray going +x enters a
 * voxel through its −x face, and so on.
 */
export function bakedFaces(voxels: SurfaceVoxel[], tanX: number, tanY: number, centre: number): BakedFace[] {
  const project = (x: number, y: number, z: number) => bake(x, y, z, tanX, tanY, centre)
  const sideX = Math.sign(tanX)
  const sideY = Math.sign(tanY)
  const faces: (BakedFace & { order: number })[] = []
  for (const { voxel, open } of voxels) {
    const { x, y, z } = voxel
    const near = z - 0.5
    const far = z + 0.5
    if (sideX !== 0 && open & (sideX > 0 ? LEFT : RIGHT)) {
      const fx = x - sideX * 0.5
      faces.push({ voxel, order: -2 * z, shade: sideX > 0 ? FACE_SHADE.left : FACE_SHADE.right, corners: [
        project(fx, y - 0.5, near), project(fx, y + 0.5, near), project(fx, y + 0.5, far), project(fx, y - 0.5, far),
      ] })
    }
    if (sideY !== 0 && open & (sideY > 0 ? BOTTOM : TOP)) {
      const fy = y - sideY * 0.5
      faces.push({ voxel, order: -2 * z, shade: sideY > 0 ? FACE_SHADE.bottom : FACE_SHADE.top, corners: [
        project(x - 0.5, fy, near), project(x + 0.5, fy, near), project(x + 0.5, fy, far), project(x - 0.5, fy, far),
      ] })
    }
    if (open & FRONT) {
      faces.push({ voxel, order: -2 * z + 1, shade: FACE_SHADE.front, corners: [
        project(x - 0.5, y - 0.5, near), project(x + 0.5, y - 0.5, near),
        project(x + 0.5, y + 0.5, near), project(x - 0.5, y + 0.5, near),
      ] })
    }
  }
  return faces.sort((a, b) => a.order - b.order)
}

/**
 * Fills a convex polygon (pixel coordinates) into a width × height pixel
 * buffer, without antialiasing: a pixel is filled when its centre is
 * inside, with half-open edges, so polygons sharing an edge neither overlap
 * nor leave a gap there. Returns whether any pixel was filled.
 */
export function fillConvex(
  pixels: Uint32Array, width: number, height: number, points: [number, number][], color: number,
): boolean {
  let top = Infinity
  let bottom = -Infinity
  for (const [, y] of points) {
    top = Math.min(top, y)
    bottom = Math.max(bottom, y)
  }
  let filled = false
  for (let row = Math.max(0, Math.ceil(top - 0.5)); row < Math.min(height, Math.ceil(bottom - 0.5)); row++) {
    const y = row + 0.5
    let left = Infinity
    let right = -Infinity
    for (let i = 0; i < points.length; i++) {
      const [x0, y0] = points[i]
      const [x1, y1] = points[(i + 1) % points.length]
      if ((y0 <= y && y < y1) || (y1 <= y && y < y0)) {
        const x = x0 + ((y - y0) / (y1 - y0)) * (x1 - x0)
        left = Math.min(left, x)
        right = Math.max(right, x)
      }
    }
    const from = Math.max(0, Math.ceil(left - 0.5))
    const to = Math.min(width, Math.ceil(right - 0.5))
    if (from >= to) continue
    pixels.fill(color, row * width + from, row * width + to)
    filled = true
  }
  return filled
}
