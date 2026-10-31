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

Valid sizes form a geometric progression `1, m, m², …` (rounded, capped at
64) where `m` is the depth multiplier (default 2). A
slice of size N may only start at depth z with `z % N == 0`:

```
z=0  → every size
z=8  → 1, 2, 4, 8
z=6  → 1, 2
```

`getSliceAtDepth(z, minSize)` returns the smallest aligned size ≥ minSize, or
the largest aligned size if none is big enough. Alignment means a given
`(depth, size)` slice always contains the same voxels, wherever the camera is.

### Camera selection (camera-dependent)

`selectSlices(cameraZ, near, far)` walks from `cameraZ + near` to
`cameraZ + far`. At each step it requests `minSize` = the largest power of
`m` ≤ viewing distance, takes what the world provides, and continues from the
end of that slice. The result tiles the range with no gaps or overlaps.

Camera at z=0, range 1–200 (multiplier 2):

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

Covering distance n takes O(log n) slices (~10 for 200 units).

## 2. Rasterisation (`renderer.ts`)

A slice's canvas is viewport-sized and drawn at a fixed `RENDER_SCALE`
(pixels per world unit) with the world origin at the canvas centre. Voxels
are orthographic squares, painted back to front within the slice. Because
the image doesn't depend on the camera, a canvas is drawn once when its
slice first appears and is never redrawn.

## 3. Compositing

Each visible slice is a `<canvas>` in the container, followed by a fog
`<div>` whose opacity grows with distance. Nearer slices get higher
`z-index`. For viewing distance d (to the slice centre) and focal length
`PROJECTION_SCALE_FACTOR`:

```
scale  = PROJECTION_SCALE_FACTOR / d          (pixels per world unit)
canvas transform: translate3d(-camera.x·scale, camera.y·scale, 0) scale(scale / RENDER_SCALE)
```

Only these style properties change as the camera moves; the canvases are
promoted to compositor layers (`will-change: transform`), so x/y movement
costs no rasterisation at all.

## 4. Caching

Layers are keyed by `depth:size`. Insertion order of the `Map` is the LRU
order. Slices that leave the view lose their DOM elements but stay cached
(up to `MAX_CACHED_LAYERS` = 32) so moving back reuses them.

| Event | Effect |
|---|---|
| x/y movement | All layers reused; transforms update |
| small z movement | Far slices reused; a few near slices re-tile |
| world regeneration, resize, multiplier change | Whole cache cleared |

Per-render stats (`UpdateStats`) report layers reused vs regenerated and
voxels rasterised; `SessionStats` accumulates them.

## Limitations

- Each slice is drawn at the scale of its centre, so thick slices are only
  approximately in perspective. Slices are thick only far away, where the
  error is small relative to their size on screen.
- Only voxel fronts are drawn; tops and sides between slices are not.
- Near slices are heavily upscaled from `RENDER_SCALE`.
