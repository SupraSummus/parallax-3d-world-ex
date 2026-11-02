# To do

Measured or derived, not yet done.
Numbers are for the forest at 1280×800 (`docs/architecture.md`).

- **Moving rebakes whole levels.**
  A level is baked again when the camera leaves its eye's cell,
  so walking rebakes 1.3–1.8× the chunks that one direction per chunk did,
  mostly of levels 0 and 1 (cells 1 and 2 units across).
  By the scaling of section 2, eyes on a lattice finer than the level's
  (N = 2^(k−1)) would cut both: detail ∝ √N,
  chunks in view ∝ detail³ and rebakes per unit moved ∝ chunks / N,
  so ∝ √N, with eyes between voxel sites.
- **Bricks on the edge of a face's rhombus are baked whole.**
  Near where a level starts, about 19 bricks meet the rhombus,
  and most of them cross its edge or the screen's.
- **Most baked pixels are hidden.**
  Over 95 % of opaque baked pixels are covered by nearer slices.
  The eye's cell bounds where the camera can see from,
  so content hidden from the whole cell need not be baked.
- **Level of detail.**
  Far slices could draw a cell of their atoms as one coarse voxel.
  At the default render distance a voxel is still about 2 px, so it pays
  only for larger distances.
  Where atoms grow, the cutoff slabs split the smaller cells (section 1):
  decide then which level draws those.
