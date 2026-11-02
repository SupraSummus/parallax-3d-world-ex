# To do

Measured or derived, not yet done.
Numbers are for the forest at 1280×800 (`docs/architecture.md`).

- **Bake each level from the camera's cell, not per chunk.**
  Bake all slices of level k in perspective from the camera's nearest
  site of (m · 2^k)·FCC.
  The error then no longer depends on chunk size (C):
  detail² ≈ √2 · m · focal / ε instead of C · focal / ε,
  about 11 instead of 27 at m = 2, so about 2.5× fewer slices.
  It removes the per-chunk directions (`directionStep`, `nearestDirection`).
  The catch: when the camera crosses a cell boundary,
  the whole level is baked again at once.
- **Bricks on the edge of a face's rhombus are baked whole.**
  Near where a level starts, about 19 bricks meet the rhombus,
  and most of them cross its edge or the screen's.
- **Most baked pixels are hidden.**
  Over 95 % of opaque baked pixels are covered by nearer slices.
  The camera's cell (first item) bounds where it can see from,
  so content hidden from the whole cell need not be baked.
- **Level of detail.**
  Far slices could draw a cell of their atoms as one coarse voxel.
  At the default render distance a voxel is still about 2 px, so it pays
  only for larger distances.
  Where atoms grow, the cutoff slabs split the smaller cells (section 1):
  decide then which level draws those.
