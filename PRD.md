# Product Requirements

A proof of concept for rendering a 3D voxel world as a stack of cached 2D
depth slices composited with parallax, instead of rasterising the scene in 3D
every frame. The demo exists to show (and measure) that idea.

## Goals

- **Cheap camera movement.** Moving mostly redraws cached images; only
  chunks coming into view or changing baking direction are rasterised.
- **Close to true perspective.** Nothing that perspective would hide shows
  by more than a set number of pixels.
- **Event-driven.** Nothing renders while the camera is idle.
- **Visible mechanics.** Users can see the slices, toggle them, and watch
  cache statistics react to their movement.

## Features

**Camera** – Arrow keys or dragging on the scene turn it all around
(up to straight up or down). W/S forward/back and A/D left/right along
where it looks (level), Space/Shift up/down, adjustable move speed, field
of view
(5°–120° across the longer screen side) and render distance (20–400).

**Slicing** – Six stacks of slices, one per face of a cube around the
camera, each cut along its face's axis. Slices are aligned powers of two
thick and grow with viewing distance; each is split into chunks, rasterised only in view and as seen
from a direction close to the camera's. Slices are thin enough that
geometry perspective would hide (e.g. stone under the lake's water
surface) never shows by more than a set number of screen pixels ("Max
Occlusion Leak", 1–64 px, default 16); the derived slice detail is shown in
the statistics. "Fill Gaps" (on by default) grows faces that run from one
slice into the next, where nothing else is drawn in their chunk, so thin
things like a floor seen from above don't show sky between slices.
"Skip Covered Chunks" (on by default) doesn't draw chunks that nearer
ones cover, and bakes them last; the picture is the same, it is there to
compare. See [DESIGN.md](DESIGN.md).

**Worlds** – Procedurally generated, regenerable with a new seed; the camera
moves to the world's spawn point.
- *Forest* (default): a 96 m × 160 m autumn forest valley at 0.5 m per
  voxel: a winding path, spruces, birches and oaks, ferns, bushes, boulders
  and fallen logs, and a ridge closing the far end. ~700k voxels.
- *City*: a 116 m × 116 m district at 0.25 m per voxel,
  for checking flat walls, thin frames and openings:
  3 × 3 blocks of 1–3 storey buildings whose rooms form a maze of doorways,
  with windows, balconies, courtyards, furniture, street lamps and trees.
  The camera starts in front of an open entrance. ~750k voxels.
- Hills, mountains, hills with trees, lake with island: small 80×80 toy
  scenes without a real-world scale.

**3D viewer** – "Open in 3D Viewer" renders the same world (same seed) as an
ordinary triangle mesh with three.js and an orbit camera, starting from the
parallax camera with the same perspective (field of view) and fog. It is
the reference for checking what a scene looks like, independent of the
slice renderer.

**Layers panel** – Thumbnail (of the chunks in view), face and depth range, thickness and
voxel count of every slice with something in view, with a visibility toggle
per slice.

**Statistics panel** – Session totals (updates, average render time, average
cache efficiency, voxels rendered) and details of the last update (layers,
slice detail, chunks in view reused vs newly baked, chunks still baking,
chunks covered, cached chunk pixels). Chunks bake in background workers, so moving never
waits for them; meanwhile a cell shows an older bake, or nothing.

## Non-goals (for the POC)

- Rolling the camera.
- Mobile/touch controls.
- Lighting beyond flat colours, distance fog and simple face shading.

## Open ideas

- Budget chunk baking per frame: a frame that brings many new chunks
  into view (moving, or turning to new faces) still takes up to ~300 ms,
  more in software WebGL.
- Measure the seams between faces against ray-cast perspective.
- Generate geometry on demand (chunks) instead of one fixed world.
- Port the toy worlds to the forest's metric scale, or drop them.
- Port baking (`bake.ts`, DOM-free) to Rust/WASM, if it becomes the bottleneck.
- Fill cells that have never been baked from the slices a re-tiled slice
  replaces, instead of showing nothing until they arrive. Covered cells
  would then not need baking at all.
- Find covered chunks faster: it adds 4–7 ms to a render.
- Generate the world in a worker: the forest takes ~0.5 s on the main
  thread at start.
- Measure the WebGL compositor on real GPUs (headless Chromium only has a
  software one); if draw calls matter, pack chunks into a texture atlas.
- Paint cut cross-sections with the colour of the surface above them: a 2D
  prototype allowed slices twice as thick at the same leak.
- Fill gaps in screen space (only pixels no layer covers) instead of
  growing faces: seen steeply from above, chunks baked straight show a
  floor only as its cut, and grown faces draw most of it.
