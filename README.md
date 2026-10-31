# Parallax Voxel Engine

A proof of concept that renders a 3D voxel world as a stack of cached 2D
depth slices composited with CSS transforms. Slices get thicker with
distance, but never so thick that they show more than a few pixels of what
true perspective would hide; camera movement mostly just moves cached
canvases.

Live demo: <https://suprasummus.github.io/parallax-world/> (deployed from `main`).

## Quick start

```bash
pnpm install
pnpm dev
```

Controls: W/S forward/back, A/D left/right, Space/Shift up/down.
"Open in 3D Viewer" shows the same scene with a conventional (three.js)
renderer and an orbit camera.

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
