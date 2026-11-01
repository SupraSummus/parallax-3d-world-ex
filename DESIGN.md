# Rendering Architecture

The world is cut into z-slices, and each slice into aligned square chunks;
each chunk in view is rasterised once, flat, as seen from a direction
close to the camera's, into a pixel buffer, and WebGL draws the buffers
on their slices' planes in perspective.
Sections 1–3 describe one such stack, looking along +z;
the camera looks all around with six, one per face of a cube (section 4).
Voxel (x, y, z) is the unit cube centred on
(x, y, z).

```
World (voxels) ──selectSlices──▶ slices ──chunks in view──▶ cached pixels ──Frame──▶ WebGL ──▶ screen
   world.ts               slice-selection.ts                  renderer.ts          compositor.ts
                                                               │      ▲
                                                 missing chunks▼      │pixels
                                                 bake workers (worker-bakery.ts)
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

`selectSlices(cameraZ, near, far, detail)` walks from the first voxel at
least `near` ahead (a nearer slice, scaled by focal / d, could fill the
screen) to `cameraZ + far`. At each step it requests `minSize` = the
largest power of two ≤ a / detail, where a is the distance to the
slice's near face (depth − 0.5), takes what the world provides (never more than requested),
and continues from the end of that slice. The result tiles the range with
no gaps or overlaps. `detail` comes from the leak tolerance (section 2);
thinner slices are always allowed, so alignment never breaks the bound.

From camera z=0 with detail 1, sizes go 1, 1, 1, 2, 2, 4, 4, 8, …: measured
to the near face, a power of two is reached one step after it is requested.

Camera at z=-67: alignment forces some slices smaller than requested
(e.g. at -62 only sizes 1, 2 are aligned), then sizes catch up:

| a | minSize | Depth | Aligned sizes | Size |
|---|---|---|---|---|
| 0.5 | 1 | -66 | 1, 2 | 1 |
| 1.5 | 1 | -65 | 1 | 1 |
| 2.5 | 2 | -64 | 1–64 | 2 |
| 4.5 | 4 | -62 | 1, 2 | 2 |
| 6.5 | 4 | -60 | 1, 2, 4 | 4 |
| 10.5 | 8 | -56 | 1–8 | 8 |
| 18.5 | 16 | -48 | 1–16 | 16 |
| 34.5 | 32 | -32 | 1–32 | 32 |
| 66.5 | 64 | 0 | 1–64 | 64 |
| 130.5 | 64 | 64 | 1–64 | 64 |
| 194.5 | 64 | 128 | 1–64 | 64 |

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
(or, closer than `detail`, by more than T voxels; see below).
T = 1: a stack only draws rays within 45° of its axis, in x and in y
(section 4).

**Derivation.** Every step below is stated and checked on random samples,
plus end to end against ray-cast perspective, in
[`src/lib/leak-bound.test.ts`](src/lib/leak-bound.test.ts); read it to
follow or change the reasoning. In short, for one lateral axis, a slice
with near face at distance a, thickness s, centre plane at D, baked along
tangent τ_b (section 3):

1. A point seen along tangent τ at depth z is drawn off by
   (τ − τ_b)·(z − D) world units at the plane.
2. In the slice |z − D| ≤ s/2, so every edge is off by at most τ_err·s/2,
   τ_err = |τ − τ_b|.
3. A hidden voxel shows past its occluder by at most both edges' errors:
   τ_err·s (the one modelling assumption; checked end to end).
4. In pixels that is τ_err·s·focal/a, and slices are at most a / detail
   thick, so at most τ_err·focal/detail.
5. A slice is cut into chunks C·s wide (C = 16), each spanning at most
   C / detail on screen.
6. Each chunk is baked along the direction, on a grid spaced by
   Δ ≤ C / detail (`directionStep`), nearest to its centre ray, so
   τ_err ≤ C / detail; on screen also τ_err ≤ T.
7. With τ_err = min(T, √(C·ε/focal)) (`bakeAngleError`) and
   detail = τ_err·focal/ε (`leakFreeDetail`, rounded up to a quarter
   octave), the leak is at most ε pixels:

```
detail = √(C·focal / ε)        (straight baking, not turned: tan(fov/2)·focal/ε = L/(2ε))
```

Measured in voxels instead of pixels, the bound would be τ_err·s ≤ ε: the
same thickness at every distance and a slice count linear in the range.
Pixels are what matters on screen, and far voxels are small, so slices
grow with distance. Slices are at least one voxel thick, though, so closer
than `detail` the leak is bounded by τ ≤ T voxels instead, which
can be more than ε pixels.

These are pixels of the view straight along the stack's axis.
A turned view draws a plane larger towards the screen's edges
(by 1 / cos² of the angle from the screen centre),
so leaks there can be up to 2× larger in a 90° view.

Slices for range 200, 1280-pixel-wide viewport, 90° (focal 640):

| ε | Straight baking: detail | Slices | Directed baking: detail | Slices |
|---|---|---|---|---|
| 16 px | 45.3 | 141 | 26.9 | 105 |

The bound is nearly tight; the ray-cast check also shows directed baking
leaking about half as much as straight baking at the same detail. It
cannot be pushed to zero by thinner slices: even size-1 slices leak,
because the back faces and the inside of the slab are flattened.

## 3. Chunks and rasterisation (`renderer.ts`, `chunk-baker.ts`, `bake.ts`)

When a slice's first chunk is baked, its voxels with a face that is not covered
by a neighbour (or a front face on the slice's near plane) are indexed by
chunk, with a bitmask of their open faces; buried voxels are dropped
(`sliceSurface`). Nothing is drawn yet.

**Chunks.** A slice of size s is split in x and y into aligned squares of
width `chunkWidth(s)` = 16·s: chunk (x0, y0) is the cell
[x0 − 0.5, x0 + w − 0.5) × [y0 − 0.5, y0 + w − 0.5) of the slice's
centre plane, x0 and y0 multiples of w (NAPOT again). A chunk is a
16s × 16s × s block; since a slice's size is about its distance / detail,
every chunk covers about the same part of the screen. Only chunks whose
cell reaches the screen are rasterised; empty ones are cached too, so
their cells are not searched again, but not shown.

**Directed baking.** Chunk (x0, y0) is baked as the parallel projection of
its slice along (τx, τy, 1), the grid direction nearest to the ray through
the cell's centre (section 2): point (x, y, z) goes to
(x − τx·(z − c), y − τy·(z − c)) on the centre plane z = c, clipped to the
cell. A cached chunk is keyed by its cell and its direction, so it does
not depend on where the camera is; moving the camera sideways or forward
rebakes a chunk only when its nearest grid direction changes. Drawn are
the faces a ray along the direction can reach: front faces not covered
by a voxel in front (except on the near plane, where the cut must show)
and open side faces facing the camera (−x when τx > 0, the top when
τy < 0, ...), painted far to near, side faces before front faces of the
same z (`chunkFaces`). Shading is shared with the reference viewer
(`FACE_SHADE`).

Faces are drawn as axis-aligned rectangles.
A side face is a parallelogram sheared along the direction;
its bounding rectangle covers a little more
(past the voxel's outline, a triangle of |τx| × |τy| / 2),
so nothing leaks (section 2).
A pixel is filled when its centre is inside, with half-open edges,
so neighbours meet without gaps or overlap (`fillFaces`).
No antialiasing: a soft 1-pixel edge magnified 20× on screen is a blur.

**Filling gaps.** A slice draws a point at depth z′
up to τ_err·|z′ − c| off (section 2),
so neighbouring slices, or chunks baked along different directions,
can pull a surface apart:
a one-voxel floor seen from high above shows lines of sky.
Each face is therefore also painted grown by
`directionError`·|z′ − c| (τ_err for the chunk's rays),
nearest first, into pixels its chunk left empty (`fillFaces`).
Faces at a slice's near and far planes grow most, up to about ε/2 pixels;
objects look up to that much fatter against what is behind them.
"Fill Gaps" turns it off.

`bake.ts` has no DOM and works on flat typed arrays,
ready for a Rust/WASM port.
A cell's surface records are stored far to near,
so painting order needs no sort:
the cell and its eight neighbours are walked one z at a time.

**Resolution.** A chunk of a size-s slice is drawn at `renderScale(s)`
pixels per world unit: 24 / s, between 2 and 10. A slice of size s ≥ 2
lies at distance ≥ s · detail, where a voxel is at most focal / (s ·
detail) ≈ 24 / s screen pixels with the defaults, so more pixels would not
show. Other settings scale the chunk on screen.

Each chunk is cropped to what is drawn; `originX`/`originY` record
the world position of its top-left corner on the centre plane. The image
doesn't depend on the camera's position, so a chunk is drawn once when it
first comes into view (with its direction) and is never redrawn.

On the forest at 1280 × 800, 90°: 105 slices, ~1300 chunks, ~43 Mpx
(straight-baked, unchunked slices: 141 slices, ~235 Mpx).

**Workers.** In the app, a frame never waits for chunks:
each render lists the missing chunks in view,
and up to 4 workers, each with a copy of the world, bake them
(`WorkerBakery`, `bake.worker.ts`, `ChunkBaker`).
Until a chunk arrives, the cell's latest bake (along an older direction) stands in;
a cell never baked shows nothing yet, e.g. right after start or when slices re-tile.
Those cells are baked first, then the rest, each near to far across all faces.
Each worker has a few dozen requests in flight,
enough to keep baking while the main thread is busy.
Without a bakery (tests), `render()` bakes missing chunks itself.

## 4. Faces, turning and compositing (`view.ts`, `renderer.ts`, `compositor.ts`)

**Faces.** The camera has a yaw and a pitch, no roll (`viewBasis`).
To look all around, the world gets six slice stacks,
one per face of a cube around the camera (`FACES`: ±x, ±y, ±z).
A face is a rotation:
its stack is sections 1–3 on a copy of the world turned so the face
looks along +z (`rotateGrid`, made by a baker when it first bakes the face),
with faces shaded by the way they face in the world (`shadedPalette`).
Each face draws only the rays within 45° of its axis,
so the faces tile the screen;
the fragment shader discards the rest of its chunks.

A chunk's baking direction depends on where the chunk is,
not on where the camera looks,
and detail is worked out for T = 1, not for the current orientation.
So turning keeps every slice and chunk;
only chunks coming into view are baked,
and faces coming into view are sliced.

**Placement.** `render()` returns a `Frame`:
the view (orientation, viewport W × H in CSS pixels,
`focal = max(W, H) / 2 / tan(fov/2)` in pixels)
and, face by face, for each slice near to far,
its distance d (to its centre plane), its chunks and its fog.
A chunk is a rectangle on the plane z = d in its face's coordinates,
its top-left corner at (originX − camera.x, originY − camera.y, d)
relative to the camera, chunk pixels / renderScale wide and high.
A camera-relative point p goes to (`projector`, and the vertex shader;
right, up and forward are the camera's axes in the face's coordinates):

```
x = W/2 + focal · (p · right) / (p · forward)
y = H/2 − focal · (p · up)    / (p · forward)
```

A face is skipped if the screen shows none of its pyramid.
Chunk cells are searched in the bounding box of the part it shows
(`faceTangents`);
a cell, then its chunk's content, is kept
if its projected corners' bounding box overlaps the viewport (`rectangleTest`).

The `Compositor` draws a frame onto one opaque WebGL 2 canvas, one
textured rectangle per chunk, then the sky behind them. Chunk pixels are
opaque or empty, so it draws near to far with a depth test and discards
empty pixels: what nearer slices cover is rejected instead of blended
(the forest stacks ~40 screens of chunks). Depth is the layer's index,
not its distance: a face's slices are parallel planes, so every ray
meets them near to far, and faces never share a pixel. A chunk's texture is uploaded
when it comes into view and deleted when it leaves. Magnified chunks are
sampled nearest, to keep voxel edges crisp; minified ones smoothly.

**Fog.** A slice at distance d keeps `exp(−d / F)` of its own colour;
the rest is the horizon colour, mixed in per pixel.
F is 0.7 × the render distance, so the far cut-off stays hazy.
d is measured along the face's axis, not the ray:
fog is the same on both sides of a seam,
but a little lighter towards the cube's edges than true distance would make it.
The sky fades from the horizon colour at eye level (elevation 0) to blue
at 32° up, along each pixel's ray, and gets the fog of the render
distance (or of the last slice, if farther).

## 5. Caching

Slices are keyed by `face:depth:size` and hold their chunks keyed by corner.
Insertion order of the slice `Map` is the LRU order. Slices and chunks that
leave the view lose their textures but stay cached so moving back
reuses them: up to `MAX_CACHED_SLICES` = 256 slices, and hidden chunks
up to `MAX_HIDDEN_CHUNK_PIXELS` = 32 Mpx (oldest slices' first).

| Event | Effect |
|---|---|
| x/y movement | Chunks still in view reused unless their baking direction changes; chunks entering the view rasterised; placements update |
| turning | Slices and chunks reused; chunks entering the view baked; a face baked for the first time turns the baker's copy of the world (forest: ~35 ms, in the workers) |
| field of view change | Focal length, hence detail and directions, change: slices still needed are reused, chunks rebaked |
| leak tolerance change | Slices still needed are reused |
| small z movement | Far slices reused; a few near slices re-tile |
| resize | Slices reused unless the longer side crosses a quarter octave (detail changes); placements update |
| gap filling toggle | Chunks rebaked (keyed by how far they are grown) |
| world regeneration | Whole cache cleared |

Per-render stats (`UpdateStats`) report chunks reused vs shown for the
first time since they were baked, chunks still baking, voxel faces baked
since the previous render and the pixels of all cached chunks;
`SessionStats` accumulates them. `renderTime` is main-thread time, which
excludes baking in workers.

## 6. Worlds (`world.ts`, `forest.ts`)

A world is a dense voxel grid plus a spawn point (`voxel-grid.ts`):
one material id byte per cell of a box, 0 for empty.
Cells are z-major, so a slice is one contiguous range.
Each baker (one per worker) keeps a turned copy for each other face it has baked
(forest: ~9 MB each).
A list of voxel objects is built only on request (reference viewer, tests).
Renderer distances are in voxels.
The forest's `VOXEL_SIZE` is 0.5 m,
so the default render distance (200) is 100 m and the fog distance 70 m.

Ground columns are filled a few voxels deep;
the renderer only draws faces that no neighbour covers.

## 7. Reference viewer (`src/viewer`)

`viewer.html` rebuilds the world from its seed
and draws every exposed voxel face with three.js.
World (x, y, z) maps to three.js (x, y, −z),
so the default camera, looking down −z, looks along world +z.
The app passes its orientation, field of view and render distance in the URL,
so from the parallax camera's position both renderers should agree.

## Limitations

- Each slice is drawn at the scale of its centre, along one direction per
  chunk, so it is only approximately in perspective; section 2 bounds the
  error.
- Faces seen from one direction per chunk: a face nearly parallel to the
  rays may be missing or slightly too wide.
- Side faces are drawn as rectangles: near the camera, towards the
  screen's corners, voxels lose their slanted edges.
- Near slices are heavily upscaled from `RENDER_SCALE`.
- Within `NEAR_DEPTH` of the camera along a face's axis nothing is
  drawn, and near voxels seen at a steep angle are the least accurate.
- Inside a voxel (the camera has no collisions), the cut faces of the
  nearest slices fill the screen.
- At a seam, the two faces slice the world differently: geometry
  crossing it can be off by up to the leak bound on each side.
- Closer than `detail`, chunks span more than `directionError`,
  so gap filling may leave gaps there.
