# Rendering Architecture

The camera looks along +z and never rotates. The world is cut into z-slices;
each slice is rasterised once, flat, into its own canvas, and the browser
composites the canvases with per-slice perspective scale and parallax offset.

```
World (voxels) ──selectSlices──▶ slices ──rasterise once──▶ cached canvases ──CSS transform──▶ screen
   world.ts               slice-selection.ts                     renderer.ts
```

## 1. Slice selection (`slice-selection.ts`)

Two constraints: slices must be thin enough not to show what perspective
hides (physical, section 2), and aligned so they can be cached (NAPOT).

### Alignment (camera-independent)

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

### Camera selection

`selectSlices(cameraZ, near, far, detail)` walks from `cameraZ + near` to
`cameraZ + far`. At each step it requests `minSize` = the largest power of
two ≤ viewing distance / detail, takes what the world provides (never more
than requested), and continues from the end of that slice. The result tiles
the range with no gaps or overlaps. `detail` comes from the leak tolerance
(section 2); thinner slices are always allowed, so alignment never breaks
the bound.

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

Covering distance n takes O(detail · log n) slices. Slices are keyed by
depth and size only, so after a detail change the slices still needed stay
cached.

## 2. Occlusion leaks

A slice is flat: everything in it is drawn at the scale of its centre. In
true perspective, the top and side faces of nearer voxels hide what lies
behind them; in slices, the gap between two slices can instead show a
cross-section of the farther slice. Too-thick slices show what perspective
hides, e.g. stone under the lake's water surface.

Bound, with ε = the "max occlusion leak" setting in screen pixels (default
16): **geometry that perspective hides never shows by more than ε pixels**
(or, closer than `detail`, by more than tan(fov/2) voxels; see below).

Derivation, for one lateral axis (x and y are independent). Take a slice
[a, a+s) at viewing distance a, drawn at distance D (its centre). A voxel
edge at lateral offset u from the camera axis really lies on a face at some
depth z ∈ [a, a+s]: front, back, top or side face. It appears at screen
angle u/z but is drawn at u/D. In world units at the slice, the error is

```
|u| · |z − D| / z  =  τ · |z − D|  ≤  τ · s/2,      τ = |u| / z
```

where τ is the tangent of the angle at which the edge is seen. A hidden
voxel can only show past an occluding edge by the error of the occluder's
edge plus the error of its own edge: τ·s world units at depth ≥ a, i.e. at
most τ·s·focal/a pixels. On screen τ·focal ≤ L/2, where L is the longer
viewport side in pixels, whatever the field of view. So

```
s  ≤  2·ε·a / L        i.e.   detail = L / (2ε)
```

`leakFreeDetail` rounds L / (2ε) up to a quarter octave, so small resizes
keep the slicing (and the cache).

Measured in voxels instead of pixels, the bound would be τ·s ≤ ε: the same
thickness at every distance and a slice count linear in the range. Pixels
are what matters on screen, and far voxels are small, so slices can grow
with distance. Slices are at least one voxel thick, though, so closer than
`detail` (where 2·ε·a/L < 1) the leak is bounded by τ ≤ tan(fov/2) voxels
instead, which can be more than ε pixels.

Slices for range 200 (camera z=−70.3):

| Viewport L | ε | detail | Slices |
|---|---|---|---|
| 1280 | 4 px | 181 | 200 |
| 1280 | 16 px | 45.3 | 142 |
| 1280 | 32 px | 22.6 | 95 |

The bound is nearly tight; the `occlusion leaks` tests compare against
ray-cast perspective. It cannot be pushed to zero by thinner slices: even
size-1 slices leak up to τ voxels, because only front faces are drawn.

## 3. Rasterisation (`renderer.ts`)

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

## 4. Compositing

Each visible slice is a `<canvas>` in the container, followed by a
full-screen fog `<div>`; nearer slices get higher `z-index`. The container
is its own stacking context (`isolate`) so the UI stays on top. For viewing
distance d (to the slice centre), viewport W × H, focal length
`focal = max(W, H) / 2 / tan(fov/2)` (pixels) and `transform-origin: 0 0`:

```
scale = focal / d                                       (pixels per world unit)
left  = W/2 + (originX − camera.x) · scale
top   = H/2 − (originY − camera.y) · scale
canvas transform: translate3d(left, top, 0) scale(scale / RENDER_SCALE)
```

Only these style properties change as the camera moves; the canvases are
promoted to compositor layers (`will-change: transform`), so x/y movement
costs no rasterisation at all. Magnified canvases use
`image-rendering: pixelated` to keep voxel edges crisp.

**Fog.** A fog overlay tints everything behind it, so overlays compound.
Walking near to far, an overlay at slice k gets opacity
`1 − exp(−(d_k − d_prev) / F)`, where d_prev is the previous overlay's
distance, once that reaches 5%; other slices get none. The accumulated fog
over a slice at distance d is then `1 − exp(−d / F)` rounded down to the
last step, regardless of how many slices there are. (One overlay per thin
slice would be nearly transparent, and hundreds of 8-bit blends drift the
colours.) The fog colour matches the sky gradient's horizon, which sits at
eye level (screen centre). The fog distance F is 0.7 × the render distance,
so the far cut-off stays hazy.

## 5. Caching

Layers are keyed by `depth:size`. Insertion order of the `Map` is the LRU
order. Slices that leave the view lose their DOM elements but stay cached
(up to `MAX_CACHED_LAYERS` = 32) so moving back reuses them.

| Event | Effect |
|---|---|
| x/y movement | All layers reused; transforms update |
| field of view change | Transforms update |
| leak tolerance change | Slices still needed are reused |
| small z movement | Far slices reused; a few near slices re-tile |
| resize | All layers reused unless the longer side crosses a quarter octave (detail changes); transforms update |
| world regeneration | Whole cache cleared |

Per-render stats (`UpdateStats`) report layers reused vs regenerated and
voxels rasterised; `SessionStats` accumulates them.

## 5. Worlds (`world.ts`, `forest.ts`)

A world is a list of integer voxels plus a spawn point.
Renderer distances are in voxels.
The forest's `VOXEL_SIZE` is 0.5 m,
so the default render distance (200) is 100 m and the fog distance 70 m.

Ground columns are filled a few voxels deep.
The renderer draws only voxel fronts,
so the ground's top surface shows as the stacked fronts of these columns.

## 6. Reference viewer (`src/viewer`)

`viewer.html` rebuilds the world from its seed
and draws every exposed voxel face with three.js.
World (x, y, z) maps to three.js (x, y, −z),
so the default camera, looking down −z, looks along world +z.
The app passes its field of view and render distance in the URL,
so from the parallax camera's position both renderers should agree.

## Limitations

- Each slice is drawn at the scale of its centre, so a slice is only
  approximately in perspective; section 2 bounds the error.
- Only voxel fronts are drawn; tops and sides between slices are not, so
  the world's edge facing the camera shows as a cross-section.
- Near slices are heavily upscaled from `RENDER_SCALE`.
