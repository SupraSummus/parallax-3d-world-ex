# Parallax Voxel Engine

A proof of concept that renders a 3D voxel world as a stack of cached 2D
depth slices composited with CSS transforms. Slices get thicker with
distance, so ~10 cached canvases cover 200 units of depth, and sideways
camera movement never re-renders pixels.

Live demo: <https://suprasummus.github.io/parallax-3d-world-ex/> (deployed from `main`).

## Quick start

```bash
pnpm install
pnpm dev
```

Controls: W/S forward/back, A/D left/right, Space/Shift up/down.

Other scripts (`test`, `lint`, `typecheck`, `knip`, `build`) are in
`package.json`.

## Documentation

| Document | Description |
|----------|-------------|
| **[AGENTS.md](AGENTS.md)** | Guide for AI agents (start here) |
| [PRD.md](PRD.md) | Product requirements |
| [DESIGN.md](DESIGN.md) | Rendering architecture |
| [TESTING.md](TESTING.md) | Testing guide |

## License

MIT, see [LICENSE](LICENSE).
