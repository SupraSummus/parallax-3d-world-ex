# Testing

Vitest with jsdom,
and `cargo test` for the baker's Rust in `bake/`.
Commands are in `package.json`:

```bash
pnpm test                       # build the baker, run both once (CI)
pnpm exec vitest                # watch mode (after pnpm wasm)
pnpm exec vitest -t "cache"     # filter by test name
```

## Layout

| File | Covers |
|------|--------|
| `src/lib/slice-selection.test.ts` | Slice math: documented examples plus invariants (contiguous, aligned, logarithmic) over a grid of camera positions and detail levels; the two cases of leak-free detail |
| `src/lib/leak-bound.test.ts` | The occlusion-leak bound as a step-by-step derivation, each step checked on seeded random samples, ending in a 2D ray-cast comparison (on the lattice's cross-section) of chunked, directed baking against true perspective |
| `src/lib/fcc.test.ts` | Voxel geometry: 12 rhombic faces towards the nearest sites, on the voxel's boundary, wound outwards, volume 2 |
| `src/lib/bake.test.ts` | The baker's chunks pixel by pixel against rays cast through the slice's voxels (surfaces, painting order, faces, rasterisation); only open faces crossing a slice plane grow; shading by world direction |
| `bake/src/fill.rs` | Shared edges filled without overlap or gaps; grown faces equal to the face swept over its growth, painted only into empty pixels |
| `src/lib/world.test.ts` | Toy world types: determinism, bounds in blocks |
| `src/lib/city.test.ts` | City: determinism, voxel budget, spawn looking through an open entrance |
| `src/lib/forest.test.ts` | Forest: determinism, coverage, voxel budget, tree heights in metres, clear spawn |
| `src/viewer/mesh.test.ts` | Reference viewer mesh: face culling between neighbours, rhombic dodecahedra at their sites, winding |
| `src/lib/view.test.ts` | Camera basis, faces are rotations, projection against screen rays, faces cover every ray on screen, culling |
| `src/lib/voxel-grid.test.ts` | Storage holds exactly the lattice's sites; round trip, refusing points off the lattice; counting a face's slice |
| `src/lib/renderer.test.ts` | Layer and chunk contents, culling to the view, baking directions, frame order and fog, perspective/parallax placement (straight ahead and turned, across faces), looking all around, cache reuse and invalidation, stats (on a small world: the forest is slow in jsdom) |
| `src/lib/occlusion.test.ts` | Skipping covered chunks leaves the picture (a software compositor's) unchanged |
| `src/lib/worker-bakery.test.ts` | Baking in workers (simulated in microtasks): same frames as baking on the main thread (straight ahead and across faces), older bakes standing in, cells showing nothing baked first, covered cells baked last (no gaps when near slices re-tile), no backlog after the camera moves, no rebaking once settled (cache past its cap), stale worlds dropped |
| `src/lib/renderer-regressions.test.ts` | Previously fixed rendering bugs, checked on chunk pixels and their placement |
| `src/App.test.tsx` | UI panels, keyboard movement and turning (with a stub forest, for speed) |

`src/test-setup.ts` stubs what jsdom lacks: a no-op 2D canvas context
(no WebGL, so `compositor.ts` is only checked in the browser),
`ResizeObserver`, and a timer-based `requestAnimationFrame`.

## Conventions

- Assert observable behaviour (layer contents, frames, stats), not
  private fields. Every test must be able to fail: no `expect(true)` or
  `toBeGreaterThanOrEqual(0)` placeholders.
- To check what was drawn, read the chunks' pixels and placements, as
  `renderer-regressions.test.ts` does.
- Prefer one invariant test over a grid of inputs to many near-identical
  example tests. For a claim about all inputs, check it on seeded random
  samples (`forAll` in `leak-bound.test.ts`) so failures reproduce.
- Visual output is not covered by unit tests; check it in the browser
  (`pnpm dev`).
