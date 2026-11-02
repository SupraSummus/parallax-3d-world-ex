# Rendering Architecture

The world is cut into slices of layers, and each slice into aligned chunks;
each chunk in view is rasterised once, flat, as seen from a direction
close to the camera's, into a pixel buffer, and WebGL draws the buffers
on their slices' planes in perspective.
Voxels are rhombic dodecahedra on the face-centred cubic (FCC) lattice
(section 6).
Sections 1–3 describe one stack of slices, looking along one of the
lattice's 12 nearest-neighbour directions;
the camera looks all around with 12, one per face of a rhombic
dodecahedron around it (section 4).
Seen along such a direction, the lattice is a stack of flat layers
LAYER = 1/√2 apart, and a voxel reaches from the layer before its own to
the one after, so neighbouring slices interlock.

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

Depths and sizes count layers. Slice sizes are powers of two up to 64.
A slice of size N may only start at depth z with `z % N == 0`:

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

`selectSlices(cameraZ, near, far, detail)` walks from the first layer at
least `near` ahead (a nearer slice, scaled by focal / d, could fill the
screen) to `cameraZ + far`. A slice of size s holds s layers but is s + 1
thick: its voxels reach from depth − 1 to depth + s. At each step it
requests `minSize` = the largest power of two ≤ a / detail − 1, where a is
the distance to the slice's near side (depth − 1), so that its thickness is
at most a / detail; it takes what the world provides (never more than requested),
and continues from the end of that slice. The result tiles the range with
no gaps or overlaps. `detail` comes from the leak tolerance (section 2);
thinner slices are always allowed, so alignment never breaks the bound.

From camera z=0 with detail 1, sizes go 1, 1, 1, 2, 2, 4, 4, 8, …: a power
of two is reached one step after it is requested.

Camera at z=-67: alignment forces some slices smaller than requested
(e.g. at -62 only sizes 1, 2 are aligned), then sizes catch up:

| a | minSize | Depth | Aligned sizes | Size |
|---|---|---|---|---|
| 0 | 1 | -66 | 1, 2 | 1 |
| 1 | 1 | -65 | 1 | 1 |
| 2 | 1 | -64 | 1–64 | 1 |
| 3 | 2 | -63 | 1 | 1 |
| 4 | 2 | -62 | 1, 2 | 2 |
| 6 | 4 | -60 | 1, 2, 4 | 4 |
| 10 | 8 | -56 | 1–8 | 8 |
| 18 | 16 | -48 | 1–16 | 16 |
| 34 | 32 | -32 | 1–32 | 32 |
| 66 | 64 | 0 | 1–64 | 64 |
| 130 | 64 | 64 | 1–64 | 64 |
| 194 | 64 | 128 | 1–64 | 64 |

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
(or, closer than 2 · `detail` layers, by more than 2T layer spacings; see
below). T = 1: a stack draws rays up to 45° from its axis (section 4).

**Derivation.** Every step below is stated and checked on random samples,
plus end to end against ray-cast perspective, in
[`src/lib/leak-bound.test.ts`](../src/lib/leak-bound.test.ts); read it to
follow or change the reasoning. In short, for one lateral axis, a slice
with near side at distance a, thickness s ((size + 1) · LAYER, as voxels
reach a layer past their own), centre plane at D, baked along tangent τ_b
(section 3):

1. A point seen along tangent τ at depth z is drawn off by
   (τ − τ_b)·(z − D) world units at the plane.
2. In the slice |z − D| ≤ s/2, so every edge is off by at most τ_err·s/2,
   τ_err = |τ − τ_b|.
3. A hidden voxel shows past its occluder by at most both edges' errors:
   τ_err·s (the one modelling assumption; checked end to end).
4. In pixels that is τ_err·s·focal/a, and slices are at most a / detail
   thick, so at most τ_err·focal/detail.
5. A slice is cut into chunks at most C·size layer spacings wide (C = 16),
   each spanning at most C / detail on screen.
6. Each chunk is baked along the direction, on a grid spaced by
   Δ ≤ C / detail (`directionStep`), nearest to its centre ray, so
   τ_err ≤ C / detail; on screen also τ_err ≤ T.
7. With τ_err = min(T, √(C·ε/focal)) (`bakeAngleError`) and
   detail = τ_err·focal/ε (`leakFreeDetail`, rounded up to a quarter
   octave), the leak is at most ε pixels:

```
detail = √(C·focal / ε)        (straight baking, not turned: tan(fov/2)·focal/ε = L/(2ε))
```

Measured in world units instead of pixels, the bound would be τ_err·s ≤ ε: the
same thickness at every distance and a slice count linear in the range.
Pixels are what matters on screen, and far voxels are small, so slices
grow with distance. Slices are at least one layer (two spacings) thick, though,
so closer than 2 · `detail` layers the leak is bounded by 2T spacings instead,
which can be more than ε pixels.

These are pixels of the view straight along the stack's axis.
A turned view draws a plane larger towards the screen's edges
(by 1 / cos² of the angle from the screen centre),
so leaks there can be up to 2× larger in a 90° view.

Slices of one face for range 400, 1280-pixel-wide viewport, 90° (focal 640):

| ε | Straight baking: detail | Slices | Directed baking: detail | Slices |
|---|---|---|---|---|
| 16 px | 45.3 | 246 | 26.9 | 168 |

The bound is nearly tight; the ray-cast check also shows directed baking
leaking about half as much as straight baking at the same detail. It
cannot be pushed to zero by thinner slices: even size-1 slices leak,
because the back faces and the inside of the slab are flattened.

## 3. Chunks and rasterisation (`renderer.ts`, `chunk-baker.ts`, `bake/`)

When a chunk cell is first baked, the voxels of the cell (and a margin
around it) with a face that is not covered by a neighbour, or a face
towards the camera whose neighbour is in the previous slice (the slice is
cut there, and the cut must show), are indexed, with a bitmask of their
open and cut faces; buried voxels are dropped (`cell_surface`). They are
read layer by layer from the world's grid in the face's lattice
coordinates (section 4).

**Chunks.** A slice is split into aligned cells of its face's lattice
(`chunkCell`): chunk (i, j) holds the voxels with a in [16s·i, 16s·(i + 1))
and b in [8s·j, 8s·(j + 1)) (lattice coordinates, section 4), and draws
[i·w, (i + 1)·w) × [j·h, (j + 1)·h) of the slice's centre plane,
w = 16s·LAYER ≈ 11.3s, h = 8s (NAPOT again, in whole sites).
Since a slice's size is about its distance / detail,
every chunk covers about the same part of the screen. Only chunks whose
cell reaches the screen are rasterised; empty ones are cached too, so
their cells are not searched again, but not shown.

**Empty cells.** A chunk draws the voxels of its cell and a margin around it
(`cellMargin`), within a few units of their b.
`LayerIndex` (`voxel-grid.ts`) holds, per face, layer c and block of 8 columns a,
the least and greatest b of its voxels.
A cell with no voxels it can draw is never baked
(on the forest, about 3 in 10 cells in view).
For the others, only the part of the cell within reach of those b
is checked against the screen and coverage (section 4),
so a treetop's chunk is not held to the sky above it.

**Directed baking.** Chunk (i, j) is baked as the parallel projection of
its slice along (τx, τy, 1), the grid direction nearest to the ray through
the cell's centre (section 2): point (x, y, z) goes to
(x − τx·(z − c), y − τy·(z − c)) on the centre plane z = c, clipped to the
cell. A cached chunk is keyed by its cell and its direction, so it does
not depend on where the camera is; moving the camera sideways or forward
rebakes a chunk only when its nearest grid direction changes.
Directions are clamped to the face's rays (section 4).
Drawn are the open (and cut) faces facing against the direction,
normal · (τx, τy, 1) < 0 (`chunk_faces`):
of a voxel's 12 faces, the one facing the camera square on,
the 4 leaning towards it, and one of the 2 parallel to the axis
(by the sign of τx); the other 6 never.
Shading, by the axes a face's normal leans towards, is shared with the
reference viewer (`faceShade`).

**Painting order.** Far to near, layer by layer:
along a ray each voxel is followed by one across a face with
normal · (τx, τy, 1) > 0: one or two layers on,
or the in-layer neighbour across a face parallel to the axis.
That face is as deep as the voxel, so a ray can't cross two in one layer,
and it enters the neighbour through a face that isn't drawn:
voxels of one layer never cover each other, and need no sorting.
A voxel's faces facing the ray never overlap either.
`src/lib/bake.test.ts` checks chunks pixel by pixel against rays cast
through the slice's voxels.

A face, a rhombus, projects to a parallelogram, filled exactly:
a pixel is filled when its centre is inside, with half-open edges,
each evaluated from its upper end,
so neighbours meet without gaps or overlap (`fill_faces`).
No antialiasing: a soft 1-pixel edge magnified 20× on screen is a blur.

**Filling gaps.** A slice draws a point at depth z′, seen at tangent σ,
(σ − τ)·(z′ − c) off (section 2).
Within a slice that keeps surfaces whole;
only where a surface goes on into the next slice can it tear.
At the boundary between slices k (nearer) and k + 1,
the nearer one draws its far edge (σ − τ_k)·s_k/2 off
and the farther one its near edge −(σ − τ_{k+1})·s_{k+1}/2 off,
so on screen they are apart by
J = (σ − τ_k)·s_k/(2D_k) + (σ − τ_{k+1})·s_{k+1}/(2D_{k+1}).
(s is the slice's thickness, size + 1.)
A surface running along z moves towards the screen centre
with depth: J opens a gap where σ is farther from the centre than τ,
and makes the slices overlap (the leak of section 2) where it is nearer.
A gap is |J| − t/D_{k+1}, as the cut of a solid t units thick covers t/D:
only thin things tear, e.g. a one-layer floor seen from high above.
So each slice closes its share:
the open faces of voxels with a neighbour in the next or previous slice
grow towards where they belong, by (σ − τ)·s/2 for the σ that open a gap
(`chunk_faces`; σ − τ is bounded from the face's offset from its cell's
centre, over the distance ≥ size · detail layers, plus half a direction step).
Faces only rays up to 1 off the direction reach are left out
(`MAX_REACH`; about 0.5 is needed with the defaults),
so a cell's surface needs only a fixed margin around it.
A grown face is its parallelogram swept over the rectangle of its growth,
a convex polygon of up to 8 corners;
grown faces are painted nearest first into pixels the chunk left empty
(`fill_faces`). Cut faces and the inside of slices don't grow.
"Fill Gaps" turns it off.

**The baker** is Rust (`bake/`), compiled to WebAssembly
and inlined into the app, so it compiles synchronously
in a worker, on the main thread (for coverage, section 4) or in Node,
with no files to fetch.
`ChunkBaker` hands it a world once:
the grid, the voxel's faces in lattice coordinates and the palettes (`bake.ts`).
Then each chunk is one call,
and its pixels are copied out of the WebAssembly memory.
A chunk's voxels are those of its cell and a margin around it
(`cell_surface`, cached per cell, so other directions reuse it),
stored by layer, far to near.

**Resolution.** A chunk of a size-s slice is drawn at `render_scale(s)`
pixels per world unit: 40 / (s + 1), between 1 and 10 (2 to 20 pixels
across a voxel). A slice of size s lies at distance ≥ (s + 1) · detail
layers, where a unit is at most focal / ((s + 1) · detail · LAYER),
about 40 / (s + 1) screen pixels at 1600 × 900 (34 / (s + 1) at 1280),
so more pixels would not show. The nearest slices get 10, so
magnified rhombi keep their slanted edges. Other settings scale the chunk
on screen.

Each chunk is cropped to what is drawn; `originX`/`originY` record
the world position of its top-left corner on the centre plane. The image
doesn't depend on the camera's position, so a chunk is drawn once when it
first comes into view (with its direction) and is never redrawn.

On the forest at 1280 × 800, 90°, looking along an axis (yaw 0):
677 slices of 5 faces, ~3200 chunks drawn,
~110 Mpx cached; a first render baking all of them takes ~7 s on one thread.
Looking diagonally (yaw 45°): 845 slices, ~5 s.
render() with everything cached takes ~30 ms in Node.

**Workers.** In the app, a frame never waits for chunks:
each render lists the missing chunks in view,
and up to 8 workers, each with a copy of the world, bake them
(`WorkerBakery`, `bake.worker.ts`, `ChunkBaker`).
Until a chunk arrives, the cell's latest bake (along an older direction) stands in;
if that one is covered (section 4), nothing is baked.
A cell never baked shows nothing yet, e.g. right after start.
Those cells are baked first, then the rest, each near to far across all faces.
When the camera moves along a face's axis, its slices re-tile.
`matchTilings` pairs the new slices with the ones drawn last,
in segments ending where both have a boundary;
until a segment's new slices have a bake in every cell they show,
the old ones are drawn instead.
The list is split by cell between the workers,
so a cell's surface is cached in one worker
(rebaking it along a new direction then takes ~40% less).
Each render's list replaces a worker's previous one;
the worker bakes it one chunk per task, taking new lists in between,
and posts each chunk at once,
without waiting for the main thread, which may be busy for hundreds of milliseconds.
Chunks posted but not yet taken when the list was made are skipped (`bakeHandler`).
Racing ahead, workers also bake far chunks that nearer ones turn out to cover:
on the forest, about a third more.
Without a bakery (tests), `render()` bakes missing chunks itself.

## 4. Faces, turning and compositing (`view.ts`, `renderer.ts`, `compositor.ts`)

**Faces.** The camera has a yaw and a pitch, no roll (`viewBasis`).
To look all around, the world gets 12 slice stacks,
one per face of a rhombic dodecahedron around the camera,
i.e. one per nearest-neighbour direction F of the lattice (`FACES`, e.g. `+x+z`).
A face is a rotation, forward = F/√2, up = the world axis across F,
right = up × forward, and its stack is sections 1–3 in those coordinates.
The rotation maps sites to sites, and every face sees the same lattice:
site p is at lattice coordinates (a, b, c) = (p · √2·right, p · up, p · F),
all even or all odd, placed at (a·LAYER, b, c·LAYER);
layer c is a rectangular grid of sites, √2 by 2 apart,
and the next layer is the same grid shifted by half a cell.
The world is read in these coordinates (`Reader` in `bake/`), with faces
shaded by the way they face in the world (`shadedPalette`).

Each face draws the rays closer to its axis than to any other face's
(`inFace`): |x| + √2·|y| ≤ z, a rhombus of tangents reaching 1
towards the world axes (where 4 faces meet) and 1/√2 towards the cube's
diagonals (where 3 meet). The faces tile the screen;
the fragment shader discards the rest of their chunks,
deciding by the pixel's ray, the same for all layers of a face,
with a hair of overlap so no seam pixel falls to neither face.
Looking straight along a world axis, as the scenes' walls and streets
invite, puts a corner of 4 faces in the middle of the screen.

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
relative to the camera, chunk pixels / `render_scale` wide and high.
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
if its projected corners' bounding box (`screenBox`) overlaps the viewport.

**Covered chunks.** Near layers cover most of what is behind them.
`Coverage` (`bake/src/coverage.rs`, run on the main thread
in its own instance of the baker's WebAssembly)
marks which 4 × 4 pixel sub-blocks of the screen
the face's layers drawn so far cover;
a cell whose box, plus 8 pixels around it, lies on covered sub-blocks
is neither drawn nor baked,
and a baked chunk is not drawn if each of its tiles
(a sixteenth of it) with something drawn lies on covered sub-blocks.
Each pixel shows one face, so coverage starts over for each face,
and sub-blocks outside the face count as covered.
A sub-block is covered once one layer's chunks draw all of the face's part of it,
but different sub-blocks may be covered by different layers:
leaves, trunks and the ground together close what none of them closes alone.
Bakers record which 4 × 4 pixel blocks of a chunk are all drawn and which partly (`solid_blocks`);
the blocks under a sub-block, plus a pixel around for smoothing, must all be drawn.
A chunk is handed to `Coverage` when first drawn or tested,
which keeps its tiles and a table of sums of its all-drawn blocks,
so testing the blocks under a rectangle takes four reads;
chunks unused for 16 renders are dropped, and handed over again if needed.
Only chunks already baked cover anything.
When the camera moves, cells coming out from behind nearer layers
show nothing until baked, a frame or two.
On the forest at 1280 × 800 a settled view bakes half the chunks it would without coverage,
and draws ~3200, of which ~1600 show a pixel.
Coverage adds ~17 ms to render() in Node,
most of it in `cover`, testing sub-blocks one by one;
the rays through each sub-block are kept per face while the camera only moves.

The `Compositor` draws a frame onto one opaque WebGL 2 canvas, one
textured rectangle per chunk, then the sky behind them. Chunk pixels are
opaque or empty, so it draws near to far with a depth test and discards
empty pixels: what nearer slices cover is rejected instead of blended
(the forest stacks ~40 screens of chunks). Depth is the layer's index,
not its distance: a face's slices are parallel planes, so every ray
meets them near to far, and faces share pixels only along seams
(the first face drawn wins there). A chunk's texture is uploaded
when it comes into view and deleted when it leaves. Magnified chunks are
sampled nearest, to keep voxel edges crisp; minified ones smoothly.

**Fog.** A slice at distance d keeps `exp(−d / F)` of its own colour;
the rest is the horizon colour, mixed in per pixel.
F is 0.7 × the render distance, so the far cut-off stays hazy.
d is measured along the face's axis, not the ray:
fog is the same on both sides of a seam,
but a little lighter towards a face's corners than true distance would make it.
The sky fades from the horizon colour at eye level (elevation 0) to blue
at 32° up, along each pixel's ray, and gets the fog of the render
distance (or of the last slice, if farther).

## 5. Caching

Slices are keyed by `face:depth:size` and hold their chunks keyed by corner.
Insertion order of the slice `Map` is the LRU order. Slices and chunks that
leave the view lose their textures but stay cached so moving back
reuses them: up to `MAX_CACHED_SLICES` = 256 slices, and hidden chunks
up to `MAX_HIDDEN_CHUNK_PIXELS` = 32 Mpx (oldest slices' first). Chunks
of cells in view are kept even if they draw nothing, or they would be
baked again on every render.

| Event | Effect |
|---|---|
| x/y movement | Chunks still in view reused unless their baking direction changes; chunks entering the view rasterised; placements update |
| turning | Slices and chunks reused; chunks entering the view baked |
| field of view change | Focal length, hence detail and directions, change: slices still needed are reused, chunks rebaked |
| leak tolerance change | Slices still needed are reused |
| small z movement | Far slices reused; a few slices re-tile, the ones they replace standing in until baked |
| resize | Slices reused unless the longer side crosses a quarter octave (detail changes); placements update |
| gap filling toggle | Chunks rebaked (keyed by how far they are grown) |
| world regeneration | Whole cache cleared |

Per-render stats (`UpdateStats`) report chunks reused vs shown for the
first time since they were baked, chunks still baking, voxel faces baked
since the previous render and the pixels of all cached chunks;
`SessionStats` accumulates them. `renderTime` is main-thread time, which
excludes baking in workers.

## 6. Worlds (`world.ts`, `forest.ts`, `city.ts`)

**The lattice** (`fcc.ts`). Voxels sit on the face-centred cubic lattice:
the integer points (x, y, z) with x + y + z even.
A voxel is a site's Voronoi cell, a rhombic dodecahedron,
the points within |dx| + |dy|, |dy| + |dz| and |dx| + |dz| ≤ 1 of it,
with 12 rhombic faces, one towards each nearest neighbour,
(±1, ±1, 0) and permutations, √2 away; its volume is 2.
It is the lattice of [complex-life](https://github.com/SupraSummus/complex-life),
whose coordinates (q, v, w) stack close-packed layers along one axis,
turned so that the world axes are its 4-fold axes:
x = q + w, y = q + v, z = v + w.
So walls and floors along the axes look alike in every direction,
and the 12 faces of section 4 map sites to sites.

**Storage** (`voxel-grid.ts`). A world is a dense voxel grid plus a spawn
point: one material id byte per site of a box, 0 for empty.
Sites are z-major, and a row (y, z) holds every other x,
so a slice is one contiguous range.
A worker reads its copy of the grid for every face (`Reader` in `bake/`),
without turned copies (forest: ~35 MB, city: ~50 MB).
A list of voxel objects is built only on request (tests).
Renderer distances are in world units: render distance 40–800, default 400.

**Scenes** describe shapes in metres and fill the sites inside them;
each world picks its own scale, the renderer assumes none.
The forest's `UNIT_SIZE` is 0.25 m per unit (neighbours 0.35 m apart),
so the default render distance is 100 m and the fog distance 70 m.
Its ground is a heightfield sampled per column of sites;
trunks are columns at least 2 units square, crowns balls, branches and
fallen logs capsules, so thin parts stay one piece on the lattice
(a single column of sites only touches at corners).
The city is planned on a 0.25 m grid (`PLAN_CELL_SIZE`):
each plan cell is a box holding four sites, lattice units of 0.125 m
(render distance 50 m), so walls stay flat and frames one piece.
The toy worlds are built of blocks 2 units wide in the same way.
Columns of ground are filled a few units deep;
the renderer only draws faces that no neighbour covers.

## 7. Reference viewer (`src/viewer`)

`viewer.html` rebuilds the world from its seed
and draws every exposed voxel face, a rhombus, with three.js.
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
- Near slices are heavily upscaled from `RENDER_SCALE`.
- Within `NEAR_DEPTH` of the camera along a face's axis nothing is
  drawn, and near voxels seen at a steep angle are the least accurate.
- Inside a voxel (the camera has no collisions), the cut faces of the
  nearest slices fill the screen.
- At a seam, the two faces slice the world differently: geometry
  crossing it can be off by up to the leak bound on each side.
  Looking along a world axis, four faces meet in the middle of the screen.
- More faces are in view at once than with a cube's six (four or more,
  against one to three), each with its own near slices: baking the view
  looking along an axis takes ~2.5× as long (section 3).
- Closer than 2 · `detail`, slices are nearer than (size + 1) · detail,
  so gap filling may leave gaps there.
- Rhombic dodecahedra have jagged outlines: a flat wall or floor is a
  surface of pyramids, and a silhouette along an axis is a zigzag.
- Four voxels per old cube, each showing up to six faces towards the
  camera instead of up to three: a first bake of the toy world in the tests takes
  ~1.4 s on one thread (0.26 s with cubes). The forest has ~2.8 M voxels
  (35 MB) and the city ~3 M (50 MB), held by the main thread and each
  worker; the reference viewer's mesh has ~10 M faces (~850 MB of buffers).
