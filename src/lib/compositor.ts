import type { Chunk, Frame } from './renderer'
import { faceBasis, viewBasis, type Basis, type Face } from './view'

// Sky gradient: from the horizon colour at eye level up to SKY_TOP at
// SKY_TOP_TANGENT (tangent of the elevation; 32°), flat above and below.
// Fog has the horizon colour.
export const SKY_TOP = '#3f73b8'
export const SKY_HORIZON = '#b9d3e8'
const SKY_TOP_TANGENT = 0.625

// Seams between faces, when shown: lines this many CSS pixels wide.
const SEAM_COLOR = '#ff2fd0'
const SEAM_WIDTH = 1.5

// One rectangle per chunk on its layer's plane, projected like
// projector() in view.ts; `view` has the camera's axes as columns, in the
// layer's face coordinates (the world's for the sky). The corners come
// from gl_VertexID, so there are no vertex buffers. The sky and the seams
// cover the screen.
const VERTEX_SHADER = `#version 300 es
uniform vec2 viewport;
uniform float focal;
uniform mat3 view;
uniform vec4 rect; // x, y of the top-left corner, width, height (camera-relative)
uniform float distance;
uniform float depth;
uniform bool sky;
uniform bool seams;
out vec2 uv;
void main() {
  uv = vec2(gl_VertexID & 1, gl_VertexID >> 1);
  if (sky || seams) {
    gl_Position = vec4(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
    return;
  }
  vec3 p = transpose(view) * vec3(rect.x + uv.x * rect.z, rect.y - uv.y * rect.w, distance);
  // Homogeneous, so the GPU clips what is behind the camera and interpolates in perspective.
  gl_Position = vec4(p.xy * focal / (viewport / 2.0), depth * p.z, p.z);
}`

// `ray` is the pixel's direction in face coordinates, the same for every
// layer of a face. A face draws only its own rays (inFace in view.ts), so
// the faces tile the screen; they overlap by a hair, so rounding never
// leaves a seam pixel to neither. Chunk pixels are opaque or empty, so
// nothing is blended: empty pixels are discarded and the depth test hides
// what nearer layers cover. The sky is one more rectangle, behind every layer.
// Seams, if shown, are drawn last, over everything, with `view` in world
// coordinates. A ray's face is the neighbour direction (±1, ±1, 0) along its
// two largest components, so faces meet where the second and third largest
// are equal in size.
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform vec2 viewport;
uniform vec2 resolution; // the canvas in device pixels
uniform float focal;
uniform mat3 view;
uniform sampler2D image;
uniform vec3 skyTop;
uniform vec3 horizon;
uniform float fog;
uniform bool sky;
uniform bool seams;
uniform vec3 seamColor;
uniform float seamWidth; // device pixels
in vec2 uv;
out vec4 color;
void main() {
  vec3 ray = view * vec3((gl_FragCoord.xy / resolution - 0.5) * viewport / focal, 1.0);
  if (seams) {
    vec3 a = abs(ray);
    float second = max(min(a.x, a.y), min(max(a.x, a.y), a.z));
    float third = min(min(a.x, a.y), a.z);
    // Device pixels to the seam, near it.
    float pixels = (second - third) / max(fwidth(second - third), 1e-9);
    color = vec4(seamColor, 1.0 - smoothstep(seamWidth / 2.0 - 0.5, seamWidth / 2.0 + 0.5, pixels));
    return;
  }
  vec3 rgb;
  if (sky) {
    float elevation = ray.y / length(ray.xz);
    rgb = mix(horizon, skyTop, clamp(elevation / ${String(SKY_TOP_TANGENT)}, 0.0, 1.0));
  } else {
    if (abs(ray.x) + sqrt(2.0) * abs(ray.y) > ray.z * 1.001) discard;
    vec4 texel = texture(image, uv);
    // Smoothing a minified chunk blends in its empty pixels; keep only the mostly opaque.
    if (texel.a < 0.5) discard;
    rgb = texel.rgb / texel.a;
  }
  color = vec4(mix(rgb, horizon, fog), 1.0);
}`

const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]

const UNIFORMS = ['viewport', 'resolution', 'focal', 'view', 'rect', 'distance', 'depth', 'skyTop', 'horizon', 'fog', 'sky', 'seams', 'seamColor', 'seamWidth'] as const
type Uniform = (typeof UNIFORMS)[number]

/**
 * Draws Frames with WebGL 2 onto one canvas, near to far with a depth test,
 * so what nearer layers cover is rejected rather than blended. A chunk is
 * uploaded as a texture when it comes into view and dropped when it leaves.
 */
export class Compositor {
  private canvas: HTMLCanvasElement
  private gl: WebGL2RenderingContext
  private uniforms = {} as Record<Uniform, WebGLUniformLocation | null>
  private textures = new Map<Chunk, WebGLTexture>()
  private frame: Frame | null = null
  private showSeams = false

  /** Throws if the browser has no WebGL 2. */
  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false })
    if (!gl) throw new Error('WebGL 2 is not available')
    this.canvas = canvas
    this.gl = gl
    this.setup()
    // The GPU may drop the context (driver reset, backgrounded tab); start
    // over when it comes back.
    canvas.addEventListener('webglcontextlost', e => {
      e.preventDefault()
      this.textures.clear()
    })
    canvas.addEventListener('webglcontextrestored', () => {
      this.setup()
      if (this.frame) this.draw(this.frame)
    })
  }

  /** Whether to draw the seams between faces over the picture; redraws the last frame. */
  setShowSeams(show: boolean) {
    this.showSeams = show
    if (this.frame) this.draw(this.frame)
  }

  draw(frame: Frame) {
    this.frame = frame
    const { gl, canvas, uniforms: u } = this
    if (gl.isContextLost()) return

    // Full device resolution keeps voxel edges sharp; capped to bound the fill cost.
    const dpr = Math.min(2, window.devicePixelRatio)
    const width = Math.round(frame.width * dpr)
    const height = Math.round(frame.height * dpr)
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    gl.viewport(0, 0, width, height)
    // The sky covers every pixel, so only depth needs clearing.
    gl.clear(gl.DEPTH_BUFFER_BIT)
    gl.uniform2f(u.viewport, frame.width, frame.height)
    gl.uniform2f(u.resolution, width, height)
    gl.uniform1f(u.focal, frame.focal)
    // Columns: the camera's right, up and forward axes.
    const setView = ({ right, up, forward }: Basis) => {
      gl.uniformMatrix3fv(u.view, false, [right, up, forward].flatMap(v => [v.x, v.y, v.z]))
    }

    // Layer i at depth z(i), strictly inside (-1, 1) so rounding never clips
    // it; the sky behind all of them, still in front of the cleared depth.
    const z = (i: number) => (2 * i + 1) / (frame.layers.length + 2) - 1
    const drawn = new Set<Chunk>()
    gl.uniform1i(u.sky, 0)
    let face: Face | null = null
    frame.layers.forEach((layer, i) => {
      if (layer.face !== face) {
        face = layer.face
        setView(faceBasis(face, frame.orientation))
      }
      const { distance, placements, fog } = layer
      gl.uniform1f(u.depth, z(i))
      gl.uniform1f(u.distance, distance)
      gl.uniform1f(u.fog, fog)
      for (const { chunk, x, y } of placements) {
        gl.bindTexture(gl.TEXTURE_2D, this.texture(chunk))
        drawn.add(chunk)
        gl.uniform4f(u.rect, x, y, chunk.width / chunk.scale, chunk.height / chunk.scale)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      }
    })
    gl.uniform1i(u.sky, 1)
    setView(viewBasis(frame.orientation))
    gl.uniform1f(u.depth, z(frame.layers.length))
    gl.uniform1f(u.fog, frame.fog)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    if (this.showSeams) {
      gl.uniform1i(u.seams, 1)
      gl.uniform1f(u.seamWidth, SEAM_WIDTH * dpr)
      gl.disable(gl.DEPTH_TEST)
      gl.enable(gl.BLEND)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      gl.disable(gl.BLEND)
      gl.enable(gl.DEPTH_TEST)
      gl.uniform1i(u.seams, 0)
    }

    for (const [chunk, texture] of this.textures) {
      if (drawn.has(chunk)) continue
      gl.deleteTexture(texture)
      this.textures.delete(chunk)
    }
  }

  private setup() {
    const { gl } = this
    const program = gl.createProgram()
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX_SHADER], [gl.FRAGMENT_SHADER, FRAGMENT_SHADER]] as const) {
      const shader = gl.createShader(type)
      if (!shader) throw new Error('WebGL could not create a shader')
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      gl.attachShader(program, shader)
    }
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'WebGL link failed')
    gl.useProgram(program)
    for (const name of UNIFORMS) {
      this.uniforms[name] = gl.getUniformLocation(program, name)
    }
    gl.uniform3f(this.uniforms.skyTop, ...rgb(SKY_TOP))
    gl.uniform3f(this.uniforms.horizon, ...rgb(SKY_HORIZON))
    gl.uniform3f(this.uniforms.seamColor, ...rgb(SEAM_COLOR))
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LESS)
  }

  private texture(chunk: Chunk): WebGLTexture {
    let texture = this.textures.get(chunk)
    if (texture) return texture
    const { gl } = this
    texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    const pixels = new Uint8Array(chunk.pixels.buffer, chunk.pixels.byteOffset, chunk.pixels.byteLength)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, chunk.width, chunk.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    // Crisp voxel edges when magnified, smooth when minified.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    this.textures.set(chunk, texture)
    return texture
  }
}
