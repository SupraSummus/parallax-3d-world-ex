/** Tests' stand-in for the compositor (compositor.ts needs WebGL, which tests lack). */
import type { Frame } from './renderer'
import { inFace, screenBox, screenRay } from './view'

/**
 * The frame's colour at every `step`-th pixel, as the compositor draws it:
 * nearest texel, nearer layers first, each face's own rays; 0 for sky.
 */
export function picture(frame: Frame, step: number): Uint32Array {
  const cols = Math.ceil(frame.width / step)
  const colour = new Uint32Array(cols * Math.ceil(frame.height / step))
  const depth = new Float64Array(colour.length).fill(Infinity)
  frame.layers.forEach(({ face, distance, placements }, index) => {
    const boxOf = screenBox(frame, face)
    for (const { chunk, x, y } of placements) {
      const box = boxOf(x, x + chunk.width / chunk.scale, y - chunk.height / chunk.scale, y, distance)
      if (!box) continue
      for (let j = Math.max(0, Math.floor(box.minY / step)); j * step < Math.min(frame.height, box.maxY); j++) {
        for (let i = Math.max(0, Math.floor(box.minX / step)); i * step < Math.min(frame.width, box.maxX); i++) {
          const k = j * cols + i
          if (depth[k] < index) continue
          const ray = screenRay(frame, face, i * step + 0.5, j * step + 0.5)
          if (!inFace(ray.x, ray.y, ray.z)) continue
          const px = Math.floor(((ray.x / ray.z) * distance - x) * chunk.scale)
          const py = Math.floor((y - (ray.y / ray.z) * distance) * chunk.scale)
          if (px < 0 || py < 0 || px >= chunk.width || py >= chunk.height) continue
          const texel = chunk.pixels[py * chunk.width + px]
          if (texel === 0) continue
          depth[k] = index
          colour[k] = texel
        }
      }
    }
  })
  return colour
}
