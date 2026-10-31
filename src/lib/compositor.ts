import type { Chunk, Frame } from './renderer'

// Sky gradient: from the top edge down to the horizon colour at eye level
// (screen centre), then flat. Fog has the horizon colour.
export const SKY_TOP = '#3f73b8'
export const SKY_HORIZON = '#b9d3e8'

// One rectangle per chunk, positioned in CSS pixels at a layer's depth. The
// four corners come from gl_VertexID, so there are no vertex buffers.
const VERTEX_SHADER = `#version 300 es
uniform vec2 viewport;
uniform vec4 rect; // left, top, width, height
uniform float depth;
out vec2 uv;
void main() {
  uv = vec2(gl_VertexID & 1, gl_VertexID >> 1);
  vec2 p = (rect.xy + uv * rect.zw) / viewport;
  gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, depth, 1.0);
}`

// Chunk pixels are opaque or empty, so nothing is blended: empty pixels are
// discarded and the depth test hides what nearer layers cover. The sky is
// one more rectangle, behind every layer.
const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
uniform sampler2D image;
uniform vec3 skyTop;
uniform vec3 horizon;
uniform float fog;
uniform bool sky;
in vec2 uv;
out vec4 color;
void main() {
  vec3 rgb;
  if (sky) {
    rgb = mix(skyTop, horizon, min(uv.y * 2.0, 1.0));
  } else {
    vec4 texel = texture(image, uv);
    // Smoothing a minified chunk blends in its empty pixels; keep only the mostly opaque.
    if (texel.a < 0.5) discard;
    rgb = texel.rgb / texel.a;
  }
  color = vec4(mix(rgb, horizon, fog), 1.0);
}`

const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]

type Uniform = 'viewport' | 'rect' | 'depth' | 'skyTop' | 'horizon' | 'fog' | 'sky'

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

    // Layer i at depth z(i); the sky behind all of them, still in front of the cleared depth.
    const z = (i: number) => (2 * i) / (frame.layers.length + 1) - 1
    const drawn = new Set<Chunk>()
    gl.uniform1i(u.sky, 0)
    frame.layers.forEach(({ placements, fog }, i) => {
      gl.uniform1f(u.depth, z(i))
      gl.uniform1f(u.fog, fog)
      for (const { chunk, left, top, scale } of placements) {
        gl.bindTexture(gl.TEXTURE_2D, this.texture(chunk))
        drawn.add(chunk)
        gl.uniform4f(u.rect, left, top, chunk.width * scale, chunk.height * scale)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      }
    })
    gl.uniform1i(u.sky, 1)
    gl.uniform1f(u.depth, z(frame.layers.length))
    gl.uniform1f(u.fog, frame.fog)
    gl.uniform4f(u.rect, 0, 0, frame.width, frame.height)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

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
    for (const name of ['viewport', 'rect', 'depth', 'skyTop', 'horizon', 'fog', 'sky'] as const) {
      this.uniforms[name] = gl.getUniformLocation(program, name)
    }
    gl.uniform3f(this.uniforms.skyTop, ...rgb(SKY_TOP))
    gl.uniform3f(this.uniforms.horizon, ...rgb(SKY_HORIZON))
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
