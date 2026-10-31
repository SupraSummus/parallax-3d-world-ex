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
| `src/lib/slice-selection.test.ts` | Slice math: documented examples plus invariants (contiguous, aligned, logarithmic) over a grid of camera positions and multipliers |
| `src/lib/world.test.ts` | Procedural generation: determinism, world types, z-range queries |
| `src/lib/renderer.test.ts` | Layer contents, DOM z-order, perspective/parallax transforms, cache reuse and invalidation, stats |
| `src/lib/renderer-regressions.test.ts` | Previously fixed rendering bugs, checked through a recording canvas context |
| `src/App.test.tsx` | UI panels and keyboard movement |

`src/test-setup.ts` stubs what jsdom lacks: a no-op 2D canvas context,
`ResizeObserver`, and a timer-based `requestAnimationFrame`.

## Conventions

- Assert observable behaviour (layer contents, CSS transforms, stats), not
  private fields. Every test must be able to fail: no `expect(true)` or
  `toBeGreaterThanOrEqual(0)` placeholders.
- jsdom does not rasterise canvases. To check what was drawn, install a
  recording context as `renderer-regressions.test.ts` does.
- Prefer one invariant test over a grid of inputs to many near-identical
  example tests.
- Visual output is not covered by unit tests; check it in the browser
  (`pnpm dev`).
