import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { World, ParallaxRenderer } from './renderer'

/**
 * Behavioral tests that demonstrate two suspected bugs without asserting on
 * implementation details. Each test sets up a scenario, renders, and checks
 * observable output (either the drawings that landed on a layer's canvas, or
 * the per-render stats exposed by the renderer).
 */

// ---------------------------------------------------------------------------
// Canvas draw-capture helper
// ---------------------------------------------------------------------------
// The global test-setup mocks `getContext` to return a fresh object every call,
// which makes it impossible to observe what was drawn on a specific canvas.
// For these tests we install a per-canvas stable mock that records every
// fillRect call. clearRect resets the recorded list (mirrors real semantics
// well enough for our purposes).
type Draw = { x: number; y: number; w: number; h: number }
const drawsByCanvas = new WeakMap<HTMLCanvasElement, Draw[]>()
// eslint-disable-next-line @typescript-eslint/unbound-method
const originalGetContext = HTMLCanvasElement.prototype.getContext

function installDrawCapture() {
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    let cached = (this as unknown as { __mockCtx?: object }).__mockCtx
    if (!cached) {
      const draws: Draw[] = []
      drawsByCanvas.set(this, draws)
      cached = {
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        globalAlpha: 1,
        canvas: this,
        fillRect: (x: number, y: number, w: number, h: number) => {
          draws.push({ x, y, w, h })
        },
        clearRect: () => {
          draws.length = 0
        },
        strokeRect: () => {},
        drawImage: () => {},
        beginPath: () => {},
        closePath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        arc: () => {},
        fill: () => {},
        stroke: () => {},
        save: () => {},
        restore: () => {},
        translate: () => {},
        rotate: () => {},
        scale: () => {},
      }
      ;(this as unknown as { __mockCtx: object }).__mockCtx = cached
    }
    return cached as unknown as CanvasRenderingContext2D
  } as unknown as typeof HTMLCanvasElement.prototype.getContext
}

function restoreDrawCapture() {
  HTMLCanvasElement.prototype.getContext = originalGetContext
}

function getDraws(canvas: HTMLCanvasElement): Draw[] {
  return drawsByCanvas.get(canvas) ?? []
}

function drawIsInsideCanvas(d: Draw, canvas: HTMLCanvasElement): boolean {
  // Any overlap between the fillRect and the canvas bitmap means at least
  // some pixels of the voxel were actually drawn onto the canvas.
  return (
    d.x + d.w > 0 &&
    d.x < canvas.width &&
    d.y + d.h > 0 &&
    d.y < canvas.height
  )
}

function makeWorldWithVoxels(voxels: World['voxels']): World {
  const world = new World(1)
  world.voxels = voxels
  return world
}

describe('Rendering bugs (behavioral)', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    installDrawCapture()
    container = document.createElement('div')
  })

  afterEach(() => {
    restoreDrawCapture()
  })

  // -------------------------------------------------------------------------
  // Bug 1: near-layer cropping
  // -------------------------------------------------------------------------
  // Claim: a voxel that the user should plainly see (directly in front of the
  // camera, at eye level, 1 unit away) currently never lands on any layer's
  // canvas bitmap, because near-layer rendering uses world-origin coordinates
  // with a huge projection scale and the canvas is only viewport-sized.
  describe('Bug 1: near-layer cropping', () => {
    it('draws a voxel at eye level 1 unit in front of the camera somewhere on a layer canvas', () => {
      const world = makeWorldWithVoxels([
        { x: 0, y: 15, z: -29, color: '#ff0000', type: 1 },
      ])
      const renderer = new ParallaxRenderer(container, world)
      renderer.resize(800, 600)
      renderer.setCamera({ x: 0, y: 15, z: -30 })

      renderer.render()

      // Gather every draw that landed inside any layer's canvas bitmap.
      const drawsOnCanvas: Array<{ canvas: HTMLCanvasElement; draw: Draw }> = []
      for (const layer of renderer.getLayers()) {
        for (const draw of getDraws(layer.canvas)) {
          if (drawIsInsideCanvas(draw, layer.canvas)) {
            drawsOnCanvas.push({ canvas: layer.canvas, draw })
          }
        }
      }

      // The voxel is directly in front of the camera at eye level. It should
      // produce at least one draw that lands inside a layer canvas (so that
      // compositing can actually show it). Currently this fails because the
      // single voxel is projected to canvas y ~= -5700 and never drawn onto
      // the 600px-tall canvas bitmap.
      expect(drawsOnCanvas.length).toBeGreaterThan(0)
    })

    it('ends up with at least one nearby voxel actually visible inside the viewport', () => {
      // A column of voxels from ground up to eye level, directly in front of
      // the camera. With camera at y=15 these span the vertical field of view
      // and should be visible on screen (grouped as one slice covering z=-29).
      const voxels: World['voxels'] = []
      for (let y = 0; y <= 15; y++) {
        voxels.push({ x: 0, y, z: -29, color: '#00ff00', type: 1 })
      }
      const world = makeWorldWithVoxels(voxels)
      const renderer = new ParallaxRenderer(container, world)
      const viewportW = 800
      const viewportH = 600
      renderer.resize(viewportW, viewportH)
      renderer.setCamera({ x: 0, y: 15, z: -30 })

      renderer.render()

      // A draw is visible if it lands inside the canvas bitmap *and*, after
      // the canvas's CSS transform (translate + optional scale around the
      // canvas centre), falls inside the viewport. We apply the same
      // transform the browser would.
      let visibleCount = 0
      for (const layer of renderer.getLayers()) {
        const canvas = layer.canvas
        const t = canvas.style.transform
        const translateMatch = t.match(
          /translate3d\(([-\d.]+)px,\s*([-\d.]+)px/,
        )
        const scaleMatch = t.match(/scale\(([-\d.]+)\)/)
        const tx = translateMatch ? parseFloat(translateMatch[1]) : 0
        const ty = translateMatch ? parseFloat(translateMatch[2]) : 0
        const s = scaleMatch ? parseFloat(scaleMatch[1]) : 1
        const cx = canvas.width / 2
        const cy = canvas.height / 2
        for (const draw of getDraws(canvas)) {
          if (!drawIsInsideCanvas(draw, canvas)) continue
          // Scale around canvas centre, then translate.
          const scaledW = draw.w * s
          const scaledH = draw.h * s
          const scaledX = cx + (draw.x - cx) * s
          const scaledY = cy + (draw.y - cy) * s
          const vx = scaledX + tx
          const vy = scaledY + ty
          if (
            vx + scaledW > 0 &&
            vx < viewportW &&
            vy + scaledH > 0 &&
            vy < viewportH
          ) {
            visibleCount++
          }
        }
      }

      // The voxels are literally directly in front of the camera at 1 unit
      // away. At least one should show up inside the viewport.
      expect(visibleCount).toBeGreaterThan(0)
    })
  })

  // -------------------------------------------------------------------------
  // Bug 2a: small Z movements invalidate every layer
  // -------------------------------------------------------------------------
  // Claim: the cache threshold is small and uniform across all layers, so
  // moving the camera by 1 z-unit (two default-speed keypresses) forces even
  // very distant layers to be re-rendered, although their projected output is
  // virtually unchanged.
  describe('Bug 2a: Z-movement cache churn', () => {
    it('reuses most layers after a 1-unit Z move from the initial camera position', () => {
      const world = new World(12345)
      const renderer = new ParallaxRenderer(container, world)
      renderer.resize(800, 600)
      renderer.setCamera({ x: 0, y: 15, z: -30 })

      renderer.render() // initial: everything dirty, regenerated once
      renderer.setCamera({ x: 0, y: 15, z: -29 })
      renderer.render()

      const stats = renderer.getStats().lastUpdate
      expect(stats).toBeDefined()
      // Very near layers (size 1 at viewingDistance ~1) legitimately need to
      // redraw because their scale changes noticeably. Distant layers that
      // cover 64 z-units shouldn't. So "reused" should meaningfully beat
      // "regenerated".
      expect(stats?.layersReused ?? 0).toBeGreaterThan(stats?.layersRegenerated ?? 0)
    })

    it('does not re-render every layer on every keypress when moving along Z', () => {
      const world = new World(12345)
      const renderer = new ParallaxRenderer(container, world)
      renderer.resize(800, 600)
      renderer.setCamera({ x: 0, y: 15, z: -30 })

      renderer.render()
      const initialRegens = renderer.getStats().totalLayersRegenerated
      const layerCount = renderer.getLayers().length

      // Simulate holding W for 8 frames at the default move speed of 0.5.
      for (let i = 1; i <= 8; i++) {
        renderer.setCamera({ x: 0, y: 15, z: -30 + i * 0.5 })
        renderer.render()
      }

      const regensDuringMovement =
        renderer.getStats().totalLayersRegenerated - initialRegens

      // A healthy cache should re-render only the slices that actually need
      // it (the near few, plus any newly-entering slice). In the worst case
      // that's comfortably less than one full re-render per frame. The bug
      // currently blows this far past layerCount * (frames / 2).
      expect(regensDuringMovement).toBeLessThan(layerCount * 2)
    })
  })

  // -------------------------------------------------------------------------
  // Bug 2b: layers are evicted on move and regenerated on return
  // -------------------------------------------------------------------------
  // Claim: the renderer only retains layers whose depths appear in the
  // current requested set. Layers that go out of range are deleted outright,
  // so moving in and then back to the original Z re-renders them from
  // scratch instead of reusing the previously-cached canvases.
  describe('Bug 2b: cache thrown away when layers leave and re-enter view', () => {
    it('reuses layers when the camera returns to an already-visited Z position', () => {
      const world = new World(12345)
      const renderer = new ParallaxRenderer(container, world)
      renderer.resize(800, 600)
      renderer.setCamera({ x: 0, y: 15, z: -30 })

      renderer.render() // warm cache at z=-30

      // Take a round trip: forward a few units, then back to the exact start.
      renderer.setCamera({ x: 0, y: 15, z: -25 })
      renderer.render()
      renderer.setCamera({ x: 0, y: 15, z: -30 })
      renderer.render()

      const returnStats = renderer.getStats().lastUpdate
      expect(returnStats).toBeDefined()
      // The camera is in exactly the same state as the first render. Every
      // slice was visible moments ago. A retaining cache would reuse nearly
      // all of them. Currently, layers that left the visible window were
      // deleted from the Map and must be rebuilt, so regenerations dominate.
      expect(returnStats?.layersReused ?? 0).toBeGreaterThan(returnStats?.layersRegenerated ?? 0)
    })
  })
})
