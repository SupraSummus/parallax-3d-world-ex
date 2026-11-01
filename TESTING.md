# Testing

Vitest with jsdom. Commands are in `package.json`:

```bash
pnpm test                       # run once (CI)
pnpm exec vitest                # watch mode
pnpm exec vitest -t "cache"     # filter by test name
```

## Layout

| File | Covers |
|------|--------|
| `src/lib/slice-selection.test.ts` | Slice math: documented examples plus invariants (contiguous, aligned, logarithmic) over a grid of camera positions and detail levels; the two cases of leak-free detail |
| `src/lib/leak-bound.test.ts` | The occlusion-leak bound as a step-by-step derivation, each step checked on seeded random samples, ending in a 2D ray-cast comparison of chunked, directed baking against true perspective |
| `src/lib/bake.test.ts` | Slice surfaces against a brute-force reference; only side faces crossing a slice plane grow; faces filled into pixels, then grown only into empty ones; shading by world direction |
| `src/lib/world.test.ts` | Toy world types: determinism, bounds |
| `src/lib/city.test.ts` | City: determinism, voxel budget, spawn looking through an open entrance |
| `src/lib/forest.test.ts` | Forest: determinism, coverage, voxel budget, tree heights in metres, clear spawn |
| `src/viewer/mesh.test.ts` | Reference viewer mesh: face culling, coordinates, winding, shading |
| `src/lib/view.test.ts` | Camera basis, faces are rotations, projection against screen rays, faces cover every ray on screen, culling |
| `src/lib/voxel-grid.test.ts` | Turned copies put every voxel at its face coordinates; counting a face's slice without turning |
| `src/lib/renderer.test.ts` | Layer and chunk contents, culling to the view, baking directions, frame order and fog, perspective/parallax placement (straight ahead and turned, across faces), looking all around, cache reuse and invalidation, stats (on a small world: the forest is slow in jsdom) |
| `src/lib/worker-bakery.test.ts` | Baking in workers (simulated in microtasks): same frames as baking on the main thread (straight ahead and across faces), older bakes standing in, cells showing nothing baked first, no backlog after the camera moves, stale worlds dropped |
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
