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

**Camera** – Looks roughly along +z: arrow keys or dragging on the scene
turn it until the screen's edge is 63° off +z. W/S forward/back and A/D
left/right along where it looks (level), Space/Shift up/down, adjustable
move speed, field of view
(5°–120° across the longer screen side) and render distance (20–400).

**Slicing** – Slices are aligned powers of two thick and grow with viewing
distance; each is split into chunks, rasterised only in view and as seen
from a direction close to the camera's. Slices are thin enough that
geometry perspective would hide (e.g. stone under the lake's water
surface) never shows by more than a set number of screen pixels ("Max
Occlusion Leak", 1–64 px, default 16); the derived slice detail is shown in
the statistics. See [DESIGN.md](DESIGN.md).

**Worlds** – Procedurally generated, regenerable with a new seed; the camera
moves to the world's spawn point.
- *Forest* (default): a 96 m × 160 m autumn forest valley at 0.5 m per
  voxel: a winding path, spruces, birches and oaks, ferns, bushes, boulders
  and fallen logs, and a ridge closing the far end. ~700k voxels.
- Hills, mountains, hills with trees, lake with island: small 80×80 toy
  scenes without a real-world scale.

**3D viewer** – "Open in 3D Viewer" renders the same world (same seed) as an
ordinary triangle mesh with three.js and an orbit camera, starting from the
parallax camera with the same perspective (field of view) and fog. It is
the reference for checking what a scene looks like, independent of the
slice renderer.

**Layers panel** – Thumbnail (of the chunks in view), z range, thickness and
voxel count of every slice with something in view, with a visibility toggle
per slice.

**Statistics panel** – Session totals (updates, average render time, average
cache efficiency, voxels rendered) and details of the last update (layers,
slice detail, chunks in view reused vs newly baked, chunks still baking,
cached chunk pixels). Chunks bake in background workers, so moving never
waits for them; meanwhile a cell shows an older bake, or nothing.

## Non-goals (for the POC)

- Looking more than 63° away from +z, or rolling the camera. Slices are
  cut along z; see the open ideas.
- Mobile/touch controls.
- Lighting beyond flat colours, distance fog and simple face shading.

## Open ideas

- Look all around: six slice stacks, one per cube face (±x, ±y, ±z),
  each drawn like the +z one and clipped to its face's 90° pyramid; only
  faces in view baked. Needs radial fog and shading by world normal in
  the stacks along x and y; seams between faces to be measured.
- Generate geometry on demand (chunks) instead of one fixed world.
- Port the toy worlds to the forest's metric scale, or drop them.
- Port baking (`bake.ts`, DOM-free) to Rust/WASM, if it becomes the bottleneck.
- Fill cells that have never been baked from the slices a re-tiled slice
  replaces, instead of showing nothing until they arrive.
- Generate the world in a worker: the forest takes ~0.5 s on the main
  thread at start.
- Measure the WebGL compositor on real GPUs (headless Chromium only has a
  software one); if draw calls matter, pack chunks into a texture atlas.
- Paint cut cross-sections with the colour of the surface above them: a 2D
  prototype allowed slices twice as thick at the same leak.
