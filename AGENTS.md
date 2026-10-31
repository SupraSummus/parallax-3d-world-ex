# Agent Development Guide

Entry point for AI agents working on this codebase. Read this first.

## Documents

| Document | Purpose | Read when |
|----------|---------|-----------|
| [README.md](README.md) | Overview and quick start | First |
| [PRD.md](PRD.md) | What the product does and doesn't do | Adding or changing features |
| [DESIGN.md](DESIGN.md) | Slicing, caching and compositing architecture | Touching `src/lib` |
| [TESTING.md](TESTING.md) | Test layout and conventions | Writing tests |

Each concept has one home: build/test commands live in `package.json`
scripts, architecture in DESIGN.md, product behaviour in PRD.md, test
conventions in TESTING.md, agent rules here. Link instead of duplicating.

## Source layout

```
src/
├── main.tsx                 # Entry: error boundary + App
├── App.tsx                  # UI panels, keyboard movement loop
├── ErrorFallback.tsx
├── main.css                 # Tailwind + design tokens
├── components/
│   ├── LayerPreview.tsx     # Layers panel
│   └── ui/                  # shadcn/ui primitives (generated; CLI config in components.json)
└── lib/
    ├── voxel-grid.ts        # Dense voxel storage (typed arrays)
    ├── world.ts             # World: voxel grid, spawn, toy world types
    ├── forest.ts            # Forest scene generator (VOXEL_SIZE lives here)
    ├── slice-selection.ts   # Slices, chunks and baking directions (pure functions)
    ├── renderer.ts          # Chunk rasterisation, caching, CSS compositing
    ├── bake.ts              # Which voxel faces a chunk shows, filled into pixels (no DOM)
    └── utils.ts             # cn() for class names
viewer.html                  # Reference 3D viewer page (second Vite entry)
src/viewer/
├── main.ts                  # three.js scene, orbit camera
└── mesh.ts                  # World -> triangle mesh of exposed faces
```

## Workflow

Before and after changing code, run the `package.json` scripts and fix
errors (lint warnings are advisory):

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm knip && pnpm knip:production
```

CI runs the same scripts plus `pnpm build`. For rendering changes, also look
at the result in the browser (`pnpm dev`); unit tests can't see pixels.

## Rules

1. **No dangling files.** Every file is imported, referenced by config, or
   linked from this file or README.md. When removing a file, remove its
   references. `knip` enforces this for code.
2. **Minimal docs.** Prefer code comments for implementation details. Delete
   outdated docs rather than letting them mislead. When changing code, grep
   the docs for mentions and update them.
3. **Architecture changes** update DESIGN.md and the affected tests.
4. **TypeScript strict** (`strictTypeChecked` ESLint rules). Follow existing
   patterns in neighbouring files.
