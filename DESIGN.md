# Rendering Architecture

The world is cut into z-slices, and each slice into aligned square chunks;
each chunk in view is rasterised once, flat, as seen from a direction
close to the camera's, into a pixel buffer, and WebGL draws the buffers
on their slices' planes in perspective.
Sections 1–3 describe one such stack, looking along +z;
the camera looks all around with six, one per face of a cube (section 4).
Voxels are rhombic dodecahedra on the face-centred cubic (FCC) lattice
(section 6): voxel (x, y, z), with x + y + z even, reaches 1 from its site
along each axis, so a layer of voxels (z fixed) interlocks with the next.

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
(or, closer than 2 · `detail`, by more than 2T units; see below).
T = 1: a stack only draws rays within 45° of its axis, in x and in y
(section 4).

**Derivation.** Every step below is stated and checked on random samples,
plus end to end against ray-cast perspective, in
[`src/lib/leak-bound.test.ts`](src/lib/leak-bound.test.ts); read it to
follow or change the reasoning. In short, for one lateral axis, a slice
with near side at distance a, thickness s (size + 1, as voxels reach 1
past their layer), centre plane at D, baked along tangent τ_b (section 3):

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

Measured in world units instead of pixels, the bound would be τ_err·s ≤ ε: the
same thickness at every distance and a slice count linear in the range.
Pixels are what matters on screen, and far voxels are small, so slices
grow with distance. Slices are at least one layer (two units) thick, though,
so closer than 2 · `detail` the leak is bounded by 2τ ≤ 2T units instead,
which can be more than ε pixels.

These are pixels of the view straight along the stack's axis.
A turned view draws a plane larger towards the screen's edges
(by 1 / cos² of the angle from the screen centre),
so leaks there can be up to 2× larger in a 90° view.

Slices for range 400, 1280-pixel-wide viewport, 90° (focal 640):

| ε | Straight baking: detail | Slices | Directed baking: detail | Slices |
|---|---|---|---|---|
| 16 px | 45.3 | 224 | 26.9 | 154 |

The bound is nearly tight; the ray-cast check also shows directed baking
leaking about half as much as straight baking at the same detail. It
cannot be pushed to zero by thinner slices: even size-1 slices leak,
because the back faces and the inside of the slab are flattened.

## 3. Chunks and rasterisation (`renderer.ts`, `chunk-baker.ts`, `bake.ts`)

When a slice's first chunk is baked, its voxels with a face that is not covered
by a neighbour, or a front face whose neighbour is in the previous slice
(the slice is cut there, and the cut must show), are indexed by chunk,
with a bitmask of their open and cut faces; buried voxels are dropped
(`sliceSurface`). Nothing is drawn yet. The slice is read layer by layer
from the world's grid in the face's coordinates (section 4).

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
rebakes a chunk only when its nearest grid direction changes.
Directions are clamped to |τ| ≤ 1, the rays a face draws.
Drawn are the open (and cut) faces facing against the direction,
normal · (τx, τy, 1) < 0 (`chunkFaces`):
of a voxel's 12 faces, the 4 whose normals lean towards −z always,
the 4 around z depending on τ, never the 4 towards +z.
Shading, by the axes a face's normal leans towards, is shared with the
reference viewer (`faceShade`).

**Painting order.** Far to near, layer by layer:
along a ray each voxel is followed by one across a face with
normal · (τx, τy, 1) > 0, so with |τ| ≤ 1 in the same layer or the next.
Within a layer, voxels are painted by τx·x + τy·y, largest first,
which grows along a ray too
(sorting by the site's distance along the direction orders any Voronoi
tiling like this). A voxel's faces facing the ray never overlap.
`src/lib/bake.test.ts` checks chunks pixel by pixel against rays cast
through the slice's voxels.

A face, a rhombus, projects to a parallelogram, filled exactly:
a pixel is filled when its centre is inside, with half-open edges,
each evaluated from its upper end,
so neighbours meet without gaps or overlap (`fillFaces`).
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
(`chunkFaces`; σ − τ is bounded from the face's offset from its cell's
centre, over the distance ≥ size · detail, plus half a direction step).
A grown face is its parallelogram swept over the rectangle of its growth,
a convex polygon of up to 8 corners;
grown faces are painted nearest first into pixels the chunk left empty
(`fillFaces`). Cut faces and the inside of slices don't grow.
"Fill Gaps" turns it off.

`bake.ts` has no DOM and works on flat typed arrays,
ready for a Rust/WASM port.
A cell's surface records are stored far to near:
the cell and its eight neighbours are walked one z at a time,
each layer sorted for painting.

**Resolution.** A chunk of a size-s slice is drawn at `renderScale(s)`
pixels per world unit: 24 / s, between 1 and 10 (2 to 20 pixels across a
voxel). A slice of size s lies at distance ≥ (s + 1) · detail, where a
unit is at most focal / ((s + 1) · detail) < 24 / s screen pixels with the
defaults, so more pixels would not show. The nearest slices get 10, so
magnified rhombi keep their slanted edges. Other settings scale the chunk
on screen.

Each chunk is cropped to what is drawn; `originX`/`originY` record
the world position of its top-left corner on the centre plane. The image
doesn't depend on the camera's position, so a chunk is drawn once when it
first comes into view (with its direction) and is never redrawn.

On the forest at 1280 × 800, 90°: 154 slices, ~1700 chunks drawn
(~2600 more covered), ~100 Mpx cached.

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
its stack is sections 1–3 on the world read in the face's coordinates
(`faceReader`: the world axes are the lattice's 4-fold axes, so the turned
sites are sites), with faces shaded by the way they face in the world
(`shadedPalette`).
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
if its projected corners' bounding box (`screenBox`) overlaps the viewport.

**Covered chunks.** Near layers cover most of what is behind them
(from the forest's spawn, about 70% of the chunks in view).
`Coverage` marks which 16 × 16 pixel cells of the screen
the layers drawn so far cover,
and a cell or chunk whose bounding box, plus 8 pixels around it,
lies on covered cells is not drawn.
A screen cell is covered once the layer's chunks draw all of its part of the plane:
bakers record which 4 × 4 pixel blocks of a chunk are all drawn (`solidBlocks`),
and the blocks under a screen cell, plus a pixel around for smoothing, must be.
Covered cells never baked are still baked, last:
when the camera moves, a near slice re-tiles and shows nothing until baked,
and what it covered must be there
(without them, up to half of a frame went empty).
Only chunks already baked cover anything.
With cube voxels, on the city at 1600 × 900, the view finished baking ~7× sooner after start
(the forest: ~1.5×), with a third of the chunks drawn;
render() took 4–7 ms more.

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
up to `MAX_HIDDEN_CHUNK_PIXELS` = 32 Mpx (oldest slices' first). Chunks
of cells in view are kept even if they draw nothing, or they would be
baked again on every render.

| Event | Effect |
|---|---|
| x/y movement | Chunks still in view reused unless their baking direction changes; chunks entering the view rasterised; placements update |
| turning | Slices and chunks reused; chunks entering the view baked |
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
and the six cube faces (section 4) map sites to sites.

**Storage** (`voxel-grid.ts`). A world is a dense voxel grid plus a spawn
point: one material id byte per site of a box, 0 for empty.
Sites are z-major, and a row (y, z) holds every other x,
so a slice is one contiguous range.
A worker reads its copy of the grid for every face (`faceReader`),
without turned copies (forest: ~35 MB, city: ~50 MB).
A list of voxel objects is built only on request (tests).
Renderer distances are in lattice units: render distance 40–800, default 400.

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
- Closer than 2 · `detail`, slices are nearer than (size + 1) · detail,
  so gap filling may leave gaps there.
- Rhombic dodecahedra have jagged outlines: a flat wall or floor is a
  surface of pyramids, and a silhouette along an axis is a zigzag.
- Four voxels per old cube, each showing up to six faces towards the
  camera instead of up to three: a first bake of the toy world in the tests takes
  ~1.4 s on one thread (0.26 s with cubes). The forest has ~2.8 M voxels
  (35 MB) and the city ~3 M (50 MB), held by the main thread and each
  worker; the reference viewer's mesh has ~10 M faces (~850 MB of buffers).
