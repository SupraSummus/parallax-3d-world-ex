/**
 * Where the camera looks: yaw and pitch away from +z, the direction the
 * world is sliced along. The slices only cover rays within MAX_VIEW_TANGENT
 * of +z, so the view may turn only as far as its corners stay inside that
 * pyramid. See DESIGN.md, section 4.
 */
import type { Vec3 } from './world'

/** Degrees. Yaw turns right (towards +x), pitch looks up (towards +y). */
export interface Orientation {
  yaw: number
  pitch: number
}

/**
 * The largest tangent (|x / z| or |y / z|) of a ray the slices are drawn
 * for. Until the other five directions get slices of their own, this is
 * how far the view may turn: 63° straight off +z.
 */
export const MAX_VIEW_TANGENT = 2

/** Camera axes in world coordinates: screen right, screen up, and the view direction. */
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
 * Focal length in pixels: the longer viewport side spans `fov` degrees.
 * Looking straight ahead, a plane d ahead is drawn at focal / d pixels per
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

/** World direction (camera-relative) through the screen point (sx, sy), in CSS pixels from the top-left. */
export function screenRay({ orientation, width, height, focal }: View, sx: number, sy: number): Vec3 {
  const { right, up, forward } = viewBasis(orientation)
  const a = sx - width / 2
  const b = height / 2 - sy
  return {
    x: forward.x * focal + right.x * a + up.x * b,
    y: forward.y * focal + right.y * a + up.y * b,
    z: forward.z * focal + right.z * a + up.z * b,
  }
}

/**
 * Bounds of x / z and y / z over the screen's rays: on the plane z = d
 * ahead of the camera, the screen shows (part of) the rectangle
 * [minX·d, maxX·d] × [minY·d, maxY·d]. Null if some screen ray does not
 * point ahead (z ≤ 0).
 */
export function viewTangents(view: View): { minX: number; maxX: number; minY: number; maxY: number } | null {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  // The screen's corners span the view; the plane cuts the pyramid in a quadrilateral.
  for (const [sx, sy] of [[0, 0], [view.width, 0], [0, view.height], [view.width, view.height]]) {
    const ray = screenRay(view, sx, sy)
    if (ray.z <= 0) return null
    minX = Math.min(minX, ray.x / ray.z)
    maxX = Math.max(maxX, ray.x / ray.z)
    minY = Math.min(minY, ray.y / ray.z)
    maxY = Math.max(maxY, ray.y / ray.z)
  }
  return { minX, maxX, minY, maxY }
}

/** Whether every ray on screen is within MAX_VIEW_TANGENT of +z. */
function inReach(view: View): boolean {
  const t = viewTangents(view)
  return t !== null && Math.max(-t.minX, t.maxX, -t.minY, t.maxY) <= MAX_VIEW_TANGENT
}

/**
 * The orientation closest to `to` along the way from `from` (assumed in
 * reach) that keeps the view in reach.
 */
function furthest(view: View, from: Orientation, to: Orientation): Orientation {
  const at = (t: number) => ({ yaw: from.yaw + (to.yaw - from.yaw) * t, pitch: from.pitch + (to.pitch - from.pitch) * t })
  if (inReach({ ...view, orientation: to })) return to
  let lo = 0
  let hi = 1
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (inReach({ ...view, orientation: at(mid) })) lo = mid
    else hi = mid
  }
  return at(lo)
}

/**
 * Turns `view` towards `target` as far as the view stays in reach: yaw
 * first, then pitch, so that pushing against the edge in one still moves
 * the other. If `view` itself is out of reach (after a resize or a wider
 * field of view), it is first pulled back towards straight ahead, which
 * is always in reach (MAX_FOV is below 2·atan(MAX_VIEW_TANGENT)).
 */
export function turn(view: View, target: Orientation): Orientation {
  if (view.width <= 0 || view.height <= 0) return target
  const ahead = { yaw: 0, pitch: 0 }
  let current = furthest(view, ahead, view.orientation)
  current = furthest(view, current, { ...current, yaw: target.yaw })
  return furthest(view, current, { ...current, pitch: target.pitch })
}

/**
 * For one view: the screen position (CSS pixels from the top-left) of a
 * camera-relative world point, or null if it is not in front of the
 * camera. The compositor's vertex shader does the same.
 */
export function projector({ orientation, width, height, focal }: View): (p: Vec3) => { x: number; y: number } | null {
  const { right, up, forward } = viewBasis(orientation)
  return p => {
    const z = p.x * forward.x + p.y * forward.y + p.z * forward.z
    if (z <= 0) return null
    const x = p.x * right.x + p.y * right.y + p.z * right.z
    const y = p.x * up.x + p.y * up.y + p.z * up.z
    return { x: width / 2 + (x * focal) / z, y: height / 2 - (y * focal) / z }
  }
}

/**
 * Whether a camera-relative rectangle [left, right] × [bottom, top] on the
 * plane z = distance may show on screen: whether its projection's bounding
 * box overlaps the viewport. Conservative: true if a corner is not in
 * front of the camera.
 */
export function rectangleTest(view: View): (left: number, right: number, bottom: number, top: number, distance: number) => boolean {
  const to = projector(view)
  return (left, right, bottom, top, distance) => {
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const [x, y] of [[left, bottom], [right, bottom], [left, top], [right, top]]) {
      const p = to({ x, y, z: distance })
      if (!p) return true
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y)
      maxY = Math.max(maxY, p.y)
    }
    return minX < view.width && maxX > 0 && minY < view.height && maxY > 0
  }
}
