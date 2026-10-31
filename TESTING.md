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
| `src/lib/bake.test.ts` | Slice surfaces against a brute-force reference; faces filled into pixels tile without gaps or overlaps |
| `src/lib/world.test.ts` | Toy world types: determinism, bounds |
| `src/lib/forest.test.ts` | Forest: determinism, coverage, voxel budget, tree heights in metres, clear spawn |
| `src/viewer/mesh.test.ts` | Reference viewer mesh: face culling, coordinates, winding, shading |
| `src/lib/renderer.test.ts` | Layer and chunk contents, culling to the view, baking directions, frame order and fog, perspective/parallax placement, cache reuse and invalidation, stats (on a small world: the forest is slow in jsdom) |
| `src/lib/renderer-regressions.test.ts` | Previously fixed rendering bugs, checked on chunk pixels and their placement |
| `src/App.test.tsx` | UI panels and keyboard movement (with a stub forest, for speed) |

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
