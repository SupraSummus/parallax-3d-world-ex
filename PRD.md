# Product Requirements

A proof of concept for rendering a 3D voxel world as a stack of cached 2D
depth slices composited with parallax, instead of rasterising the scene in 3D
every frame. The demo exists to show (and measure) that idea.

## Goals

- **Cheap camera movement.** Moving sideways or vertically only changes CSS
  transforms; moving forward re-renders a few near slices at most.
- **Event-driven.** Nothing renders while the camera is idle.
- **Visible mechanics.** Users can see the slices, toggle them, and watch
  cache statistics react to their movement.

## Features

**Camera** – Fixed viewing direction (+z), no rotation. W/S forward/back,
A/D left/right, Space/Shift up/down, adjustable move speed, field of view
(5°–120° across the longer screen side) and render distance (20–400).

**Slicing** – Slices are aligned powers of two thick and grow with viewing
distance. They are thin enough that geometry perspective would hide (e.g.
stone under the lake's water surface) never shows by more than a set number
of screen pixels ("Max Occlusion Leak", 1–64 px, default 16); the derived
slice detail is shown in the statistics. See [DESIGN.md](DESIGN.md).

**Worlds** – Procedurally generated, regenerable with a new seed; the camera
moves to the world's spawn point.
- *Forest* (default): a 96 m × 160 m autumn forest valley at 0.5 m per
  voxel: a winding path, spruces, birches and oaks, ferns, bushes, boulders
  and fallen logs, and a ridge closing the far end. ~700k voxels.
- Hills, mountains, hills with trees, lake with island: small 80×80 toy
  scenes without a real-world scale.

**3D viewer** – "Open in 3D Viewer" renders the same world (same seed) as an
ordinary triangle mesh with three.js and an orbit camera, starting from the
parallax camera with the same perspective (field of view) and fog. It is the reference for checking
what a scene looks like, independent of the slice renderer.

**Layers panel** – Thumbnail, z range, thickness and voxel count of every
non-empty slice in view, with a visibility toggle per slice.

**Statistics panel** – Session totals (updates, average render time, average
cache efficiency, voxels rendered) and details of the last update (layers
reused vs regenerated).

## Non-goals (for the POC)

- Camera rotation. Slices are only valid for a fixed viewing direction.
- Mobile/touch controls.
- Lighting beyond flat colours, distance fog and simple face shading.

## Open ideas

- Throttle or budget slice regeneration during fast forward movement.
- Generate geometry on demand (chunks) instead of one fixed world.
- Store worlds in typed arrays instead of one object per voxel
  (the forest has ~700k).
- Port the toy worlds to the forest's metric scale, or drop them.
- Move rasterisation to a worker or WebAssembly if it becomes the bottleneck.
