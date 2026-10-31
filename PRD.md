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
A/D left/right, Space/Shift up/down, adjustable move speed.

**Slicing** – Slice thickness grows geometrically with viewing distance;
the growth factor ("depth multiplier", 1.2–4) is adjustable. See
[DESIGN.md](DESIGN.md).

**Worlds** – Procedurally generated 80×80 terrain, regenerable with a new
seed. Types: forest, hills, mountains, hills with trees, lake with island.

**Layers panel** – Thumbnail, z range, thickness and voxel count of every
visible slice, with a visibility toggle per slice.

**Statistics panel** – Session totals (updates, average render time, average
cache efficiency, voxels rendered) and details of the last update (layers
reused vs regenerated).

## Non-goals (for the POC)

- Camera rotation. Slices are only valid for a fixed viewing direction.
- Mobile/touch controls.
- Lighting beyond flat colours, distance fog and simple face shading.

## Open ideas

- Throttle or budget slice regeneration during fast forward movement.
- Generate geometry on demand (chunks) instead of one fixed 80×80 world.
- Move rasterisation to a worker or WebAssembly if it becomes the bottleneck.
