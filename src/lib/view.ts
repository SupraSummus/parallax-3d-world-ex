/**
 * The camera's view and the six faces of the cube around it. Each face
 * has its own stack of slices, cut along its axis, and draws the rays
 * within 45° of that axis. See DESIGN.md, section 4.
 */
import type { Vec3 } from './world'

/** Degrees. Yaw turns right (towards +x), pitch looks up (towards +y). */
export interface Orientation {
  yaw: number
  pitch: number
}

/** Axes in world coordinates: screen right, screen up, and the view direction. */
export interface Basis {
  right: Vec3
  up: Vec3
  forward: Vec3
}

export function viewBasis({ yaw, pitch }: Orientation): Basis {
  const y = (yaw * Math.PI) / 180
  const p = (pitch * Math.PI) / 180
  return {
    right: { x: Math.cos(y), y: 0, z: -Math.sin(y) },
    up: { x: -Math.sin(y) * Math.sin(p), y: Math.cos(p), z: -Math.cos(y) * Math.sin(p) },
    forward: { x: Math.sin(y) * Math.cos(p), y: Math.sin(p), z: Math.cos(y) * Math.cos(p) },
  }
}

/**
 * A face of the cube: the camera's axes looking straight at it. Its slices
 * are cut along `forward`, in face coordinates (x, y, z) = world
 * x · right + y · up + z · forward; +z is the world itself.
 */
export interface Face extends Basis {
  name: string
}

const axis = (x: number, y: number, z: number): Vec3 => ({ x, y, z })
export const FACES: readonly Face[] = [
  { name: '+z', right: axis(1, 0, 0), up: axis(0, 1, 0), forward: axis(0, 0, 1) },
  { name: '+x', right: axis(0, 0, -1), up: axis(0, 1, 0), forward: axis(1, 0, 0) },
  { name: '-z', right: axis(-1, 0, 0), up: axis(0, 1, 0), forward: axis(0, 0, -1) },
  { name: '-x', right: axis(0, 0, 1), up: axis(0, 1, 0), forward: axis(-1, 0, 0) },
  { name: '+y', right: axis(1, 0, 0), up: axis(0, 0, -1), forward: axis(0, 1, 0) },
  { name: '-y', right: axis(1, 0, 0), up: axis(0, 0, 1), forward: axis(0, -1, 0) },
]

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z

/** World vector v in the coordinates of `axes`. */
export function toLocal(axes: Basis, v: Vec3): Vec3 {
  return { x: dot(v, axes.right), y: dot(v, axes.up), z: dot(v, axes.forward) }
}

/** The camera's axes in a face's coordinates. */
export function faceBasis(face: Face, orientation: Orientation): Basis {
  const { right, up, forward } = viewBasis(orientation)
  return { right: toLocal(face, right), up: toLocal(face, up), forward: toLocal(face, forward) }
}

/**
 * Focal length in pixels: the longer viewport side spans `fov` degrees.
 * Looking straight at a plane d ahead, it is drawn at focal / d pixels per
 * world unit.
 */
export function focalLength(fov: number, width: number, height: number): number {
  return Math.max(width, height) / 2 / Math.tan((fov * Math.PI) / 360)
}

/** A view: orientation, viewport in CSS pixels and focal length in pixels. */
export interface View {
  orientation: Orientation
  width: number
  height: number
  focal: number
}

/** Direction through the screen point (sx, sy), in CSS pixels from the top-left, in a face's coordinates. */
export function screenRay(view: View, face: Face, sx: number, sy: number): Vec3 {
  const { right, up, forward } = faceBasis(face, view.orientation)
  const a = sx - view.width / 2
  const b = view.height / 2 - sy
  return {
    x: forward.x * view.focal + right.x * a + up.x * b,
    y: forward.y * view.focal + right.y * a + up.y * b,
    z: forward.z * view.focal + right.z * a + up.z * b,
  }
}

/**
 * Clips a convex polygon to the half-space distance(p) ≥ 0 (Sutherland–
 * Hodgman), for a linear `distance`. Points can be rays: through the
 * origin, a half-space of rays is a half-space of vectors.
 */
function clip(polygon: Vec3[], distance: (p: Vec3) => number): Vec3[] {
  const out: Vec3[] = []
  polygon.forEach((p, i) => {
    const q = polygon[(i + 1) % polygon.length]
    const [dp, dq] = [distance(p), distance(q)]
    if (dp >= 0) out.push(p)
    if ((dp < 0) !== (dq < 0)) {
      const t = dp / (dp - dq)
      out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, z: p.z + (q.z - p.z) * t })
    }
  })
  return out
}

const PYRAMID_SIDES = [(p: Vec3) => p.z - p.x, (p: Vec3) => p.z + p.x, (p: Vec3) => p.z - p.y, (p: Vec3) => p.z + p.y]

/**
 * Where the screen meets a face's pyramid of rays (|x| ≤ z, |y| ≤ z):
 * bounds of x / z and y / z there, within [-1, 1]. On the face's plane
 * z = d, the face draws (part of) [minX·d, maxX·d] × [minY·d, maxY·d].
 * Null if the screen shows none of the face.
 */
export function faceTangents(view: View, face: Face): { minX: number; maxX: number; minY: number; maxY: number } | null {
  const { width: w, height: h } = view
  let rays = [[0, 0], [w, 0], [w, h], [0, h]].map(([sx, sy]) => screenRay(view, face, sx, sy))
  for (const side of PYRAMID_SIDES) rays = clip(rays, side)
  const tangents = rays.map(r => ({ x: r.x / r.z, y: r.y / r.z }))
  // Shoelace area: a face the screen only touches along an edge shows nothing.
  const area = tangents.reduce((sum, p, i) => {
    const q = tangents[(i + 1) % tangents.length]
    return sum + p.x * q.y - q.x * p.y
  }, 0)
  if (!(Math.abs(area) > 1e-9)) return null
  const xs = tangents.map(t => t.x)
  const ys = tangents.map(t => t.y)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

/**
 * For one view and face: the screen position (CSS pixels from the
 * top-left) of a camera-relative point in face coordinates, or null if it
 * is not in front of the camera. The compositor's vertex shader does the
 * same.
 */
export function projector(view: View, face: Face): (p: Vec3) => { x: number; y: number } | null {
  const camera = faceBasis(face, view.orientation)
  return p => {
    const z = dot(p, camera.forward)
    if (z <= 0) return null
    return {
      x: view.width / 2 + (dot(p, camera.right) * view.focal) / z,
      y: view.height / 2 - (dot(p, camera.up) * view.focal) / z,
    }
  }
}

/** Points nearer the camera plane than this are cut off before projecting. */
const NEAR_PLANE = 1e-3

/** A rectangle on screen, CSS pixels from the top-left. */
export interface ScreenBox {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

/**
 * For one view and face: the screen bounding box of the part in front of
 * the camera of a camera-relative rectangle [left, right] × [bottom, top]
 * on the face's plane z = distance (face coordinates), or null if none of
 * it is in front.
 */
export function screenBox(view: View, face: Face): (left: number, right: number, bottom: number, top: number, distance: number) => ScreenBox | null {
  const { forward } = faceBasis(face, view.orientation)
  const to = projector(view, face)
  return (left, right, bottom, top, distance) => {
    const corners = [[left, bottom], [right, bottom], [right, top], [left, top]].map(([x, y]) => ({ x, y, z: distance }))
    const points = clip(corners, p => dot(p, forward) - NEAR_PLANE).flatMap(p => to(p) ?? [])
    if (points.length === 0) return null
    const xs = points.map(p => p.x)
    const ys = points.map(p => p.y)
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
  }
}

/** Whether a screen box overlaps the viewport. */
export function onScreen(view: View, box: ScreenBox | null): box is ScreenBox {
  return box !== null && box.minX < view.width && box.maxX > 0 && box.minY < view.height && box.maxY > 0
}
