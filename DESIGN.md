# Rendering Architecture

The camera looks along +z and never rotates. The world is cut into z-slices;
each slice is rasterised once, flat, into its own canvas, and the browser
composites the canvases with per-slice perspective scale and parallax offset.

```
World (voxels) ──selectSlices──▶ slices ──rasterise once──▶ cached canvases ──CSS transform──▶ screen
   world.ts               slice-selection.ts                     renderer.ts
```

## 1. Slice selection (`slice-selection.ts`)

Two mechanisms, so that slices are both cacheable and adapted to the camera.

### World availability (camera-independent)

Slice sizes are powers of two up to 64. A slice of size N may only start at
depth z with `z % N == 0`:

```
z=0  → every size
z=8  → 1, 2, 4, 8
z=6  → 1, 2
```

`getSliceAtDepth(z, minSize)` returns the smallest aligned size ≥ minSize, or
the largest aligned size if none is big enough. Alignment means a given
`(depth, size)` slice always contains the same voxels, wherever the camera is.

Sizes must nest (each divides the next) for alignment to work: with
non-power sizes such as 1, 2, 3, 5, 8, … few sizes are aligned at any depth
and the walk jumps to huge slices.

### Camera selection (camera-dependent)

`selectSlices(cameraZ, near, far, detail)` walks from `cameraZ + near` to
`cameraZ + far`. At each step it requests `minSize` = the largest power of
two ≤ viewing distance / detail, takes what the world provides, and
continues from the end of that slice. The result tiles the range with no
gaps or overlaps.

**Detail** (default 4, adjustable 1–16 in the UI) trades slice count for
accuracy: each slice is drawn at the scale of its centre, so a slice as
thick as its distance (detail 1) flattens everything inside it into a wall,
while detail 4 keeps slices at most a quarter of their distance thick.
Changing detail keeps the cache: slices are keyed by depth and size only.

| Detail | Max slices (range 200) |
|---|---|
| 1 | 14 |
| 2 | 20 |
| 4 | 30 |
| 8 | 47 |

Camera at z=0, range 1–200, detail 1:

| Viewing dist | minSize | Depth | Aligned sizes | Size |
|---|---|---|---|---|
| 1 | 1 | 1 | 1 | 1 |
| 2 | 2 | 2 | 1, 2 | 2 |
| 4 | 4 | 4 | 1–4 | 4 |
| 8 | 8 | 8 | 1–8 | 8 |
| 16 | 16 | 16 | 1–16 | 16 |
| 32 | 32 | 32 | 1–32 | 32 |
| 64 | 64 | 64 | 1–64 | 64 |
| 128 | 64 | 128 | 1–64 | 64 |
| 192 | 64 | 192 | 1–64 | 64 |

Camera at z=-67: alignment forces some slices smaller than requested
(e.g. at -62 only sizes 1, 2 are aligned), then sizes catch up:

| Viewing dist | minSize | Depth | Aligned sizes | Size |
|---|---|---|---|---|
| 1 | 1 | -66 | 1, 2 | 1 |
| 2 | 2 | -65 | 1 | 1 |
| 3 | 2 | -64 | 1–64 | 2 |
| 5 | 4 | -62 | 1, 2 | 2 |
| 7 | 4 | -60 | 1, 2, 4 | 4 |
| 11 | 8 | -56 | 1–8 | 8 |
| 19 | 16 | -48 | 1–16 | 16 |
| 35 | 32 | -32 | 1–32 | 32 |
| 67 | 64 | 0 | 1–64 | 64 |
| 131 | 64 | 64 | 1–64 | 64 |
| 195 | 64 | 128 | 1–64 | 64 |

Covering distance n takes O(detail · log n) slices.

## 2. Rasterisation (`renderer.ts`)

A slice is drawn orthographically at a fixed `RENDER_SCALE` (pixels per
world unit). Within one slice every voxel at the same (x, y) lands on the
same square, so only the nearest one is drawn: a slice of ~70k voxels
becomes a few thousand squares. The canvas is cropped to the slice's x/y
extent; `originX`/`originY` record the world position of its top-left
corner (voxel (x, y) covers [x ± 0.5] × [y ± 0.5]).

Each square gets a darker bottom/right edge (voxel outlines) and, when the
cell above is empty in the world, a lighter top edge.

Because the image doesn't depend on the camera or the viewport, a canvas is
drawn once when its slice first appears and is never redrawn.

## 3. Compositing

Each visible slice is a `<canvas>` in the container, followed by a
full-screen fog `<div>`; nearer slices get higher `z-index`. The container
is its own stacking context (`isolate`) so the UI stays on top. For viewing
distance d (to the slice centre), focal length `PROJECTION_SCALE_FACTOR` and
viewport W × H, with `transform-origin: 0 0`:

```
scale = PROJECTION_SCALE_FACTOR / d                     (pixels per world unit)
left  = W/2 + (originX − camera.x) · scale
top   = H/2 − (originY − camera.y) · scale
canvas transform: translate3d(left, top, 0) scale(scale / RENDER_SCALE)
```

Only these style properties change as the camera moves; the canvases are
promoted to compositor layers (`will-change: transform`), so x/y movement
costs no rasterisation at all. Magnified canvases use
`image-rendering: pixelated` to keep voxel edges crisp.

**Fog.** A fog overlay tints everything behind it, so overlays compound.
Overlay k gets opacity `1 − exp(−(d_k − d_{k−1}) / FOG_DISTANCE)`, which
makes the accumulated fog over slice k exactly `1 − exp(−d_k / FOG_DISTANCE)`
regardless of how many slices there are. The fog colour matches the sky
gradient's horizon, which sits at eye level (screen centre).

## 4. Caching

Layers are keyed by `depth:size`. Insertion order of the `Map` is the LRU
order. Slices that leave the view lose their DOM elements but stay cached
(up to `MAX_CACHED_LAYERS` = 32) so moving back reuses them.

| Event | Effect |
|---|---|
| x/y movement | All layers reused; transforms update |
| small z movement | Far slices reused; a few near slices re-tile |
| resize | All layers reused; transforms update |
| detail change | Slices still needed are reused |
| world regeneration | Whole cache cleared |

Per-render stats (`UpdateStats`) report layers reused vs regenerated and
voxels rasterised; `SessionStats` accumulates them.

## Limitations

- Each slice is drawn at the scale of its centre, so a slice is only
  approximately in perspective; the error grows with thickness / distance,
  i.e. shrinks with detail.
- Only voxel fronts are drawn; tops and sides between slices are not, so
  the world's edge facing the camera shows as a cross-section.
- Near slices are heavily upscaled from `RENDER_SCALE`.
