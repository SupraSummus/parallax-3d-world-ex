# Layer-Based Rendering Architecture

## Overview

The parallax rendering engine uses **two distinct mechanisms** that work together:

### Mechanism 1: Camera-Independent World Slicing
- Slices have **FIXED positions in absolute world coordinates**
- Slice sizes are determined by **absolute z-coordinate** (geometric progression)
- Slices are rendered **FLAT (orthographic)** without any camera/perspective info
- Slice boundaries are globally consistent and never change
- Slices exist lazily - only rendered when requested by the camera

### Mechanism 2: Camera-Dependent Selection & Compositing
- Camera determines **WHICH slices are visible** (selection based on viewing range)
- Selected slices are rendered lazily when first requested
- **Compositing applies parallax effect** using camera position
- Closer layers move more with camera movement, creating depth perception

## Design Principles

### World Slicing (Mechanism 1 - Camera-Independent)

Slices are defined based on **absolute z-coordinate** using geometric progression:

```
World Z:  0    1    2    4         8                16               32
          │────│────│────│─────────│─────────────────│─────────────────│...
          │ 1  │ 1  │ 2  │    4    │        8        │       16        │
          └────┴────┴────┴─────────┴─────────────────┴─────────────────┘
          Geometric slice sizes (size = largest power of 2 ≤ |z|)
```

Key properties:
- Slice size = largest power of 2 ≤ |absolute z|
- Slices are aligned to their size boundaries (z=8 has size-8 slice starting at 8)
- Capped at maxSize (64) to prevent extremely large slices
- **Same z-coordinate always belongs to same slice regardless of camera position**
- Slices are rendered flat/orthographic (no perspective)

### Selection & Compositing (Mechanism 2 - Camera-Dependent)

Given fixed world slices:
1. **Selection**: Camera position determines visible range: `[camera.z + minDepth, camera.z + maxDepth]`
2. **Lazy Rendering**: Slices overlapping visible range are rendered (flat) on demand
3. **Compositing**: Rendered slices are composited with parallax offset based on camera position
4. **Parallax Effect**: `offset = -camera.xy * scale(viewingDistance)` - closer layers move more

### Slice Progression Example

For any camera position, world z-coordinates map to consistent slices:

| World Z Range | Size | Slice Start |
|--------------|------|-------------|
| [0, 1)       | 1    | 0           |
| [1, 2)       | 1    | 1           |
| [2, 4)       | 2    | 2           |
| [4, 8)       | 4    | 4           |
| [8, 16)      | 8    | 8           |
| [16, 32)     | 16   | 16          |
| [32, 64)     | 32   | 32          |
| [64, 128)    | 64   | 64          |
| [128, 192)   | 64   | 128 (capped)|

### Layer Lifecycle

```
Layer State: REQUESTED → FLAT_RENDER → CACHED → COMPOSITED
                 │            │           │          │
      (Camera selects) (Orthographic) (Reused)  (Parallax applied)
```

- **REQUESTED**: Camera's visible range overlaps this slice
- **FLAT_RENDER**: Slice voxels rendered orthographically (camera-independent)
- **CACHED**: Rendered slice content reused across frames
- **COMPOSITED**: Slice drawn to screen with parallax offset based on camera

### Cache Strategy

| Movement Type | Slice Behavior | Cache Behavior |
|---------------|----------------|----------------|
| X/Y movement  | Same slices visible | Cached, only parallax offset changes |
| Z movement (small) | Some slices enter/exit view | Cached slices reused, new ones rendered |
| Z movement (large) | Many slices enter/exit view | More new slices rendered |

### Key Insight: Why Camera-Independent Slicing?

If slices moved with camera (viewing-distance-based), objects would "jump" between different-sized slices as camera moves. With camera-independent slicing:

- World z=10 is **always** in the slice [8, 16) with size 8
- Moving camera toward z=10 doesn't change which slice contains it
- The parallax effect during compositing creates proper depth perception
- No visual discontinuities during smooth camera movement

### Implementation Functions

1. `getSliceSizeForAbsoluteZ(z)` - Returns power-of-2 size based on absolute z
2. `getSliceContainingZ(z)` - Returns the canonical slice for a z-coordinate
3. `generateSlicesForRange(minZ, maxZ)` - Generates camera-independent slices
4. `selectSlices(cameraZ, minRelativeDepth, maxRelativeDepth)` - Camera selects visible slices

## Benefits

- **O(log n) efficiency**: Covering distance n requires only ~log₂(n) slices
- **Stable boundaries**: Same z always in same slice, no visual jumping
- **Better caching**: Slices reused when camera moves laterally
- **Predictable behavior**: Slice structure is deterministic and globally consistent
- **Proper parallax**: Compositing stage applies depth-based movement
