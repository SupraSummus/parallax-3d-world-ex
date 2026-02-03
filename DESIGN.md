# Layer-Based Rendering Architecture

## Overview

The parallax rendering engine uses **two distinct mechanisms** that work together:

### Mechanism 1: Camera-Independent World Slicing
- Slices have **FIXED positions in absolute world coordinates**
- Slice sizes are determined by **alignment constraints** (power-of-2 divisibility)
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

Slices are defined based on **alignment constraints**: a slice of size N can only start at a depth where `depth % N == 0`:

```
Alignment Rule:
- Size-1 slices can start at any integer z
- Size-2 slices can only start at z % 2 == 0  (0, 2, 4, 6, ...)
- Size-4 slices can only start at z % 4 == 0  (0, 4, 8, 12, ...)
- Size-8 slices can only start at z % 8 == 0  (0, 8, 16, 24, ...)
- etc.

World Z:  0    1    2    4         8                16               32
          │────│────│────│─────────│─────────────────│─────────────────│...
          │ 1  │ 1  │ 2  │    4    │        8        │       16        │
          └────┴────┴────┴─────────┴─────────────────┴─────────────────┘
          Alignment-based slice sizes (size = largest power of 2 dividing depth)
```

Key properties:
- Slice size at depth d = largest power of 2 that divides d evenly
- Slices are aligned to their size boundaries (depth % size == 0)
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

For any camera position, world z-coordinates map to consistent slices.
The slice size is determined by the alignment of the starting depth:

| Slice Start | Size | End | Alignment Reason |
|-------------|------|-----|------------------|
| 0           | 1    | 1   | |z| < 1 defaults to size 1 for proper origin coverage |
| 1           | 1    | 2   | 1 % 1 == 0, 1 % 2 != 0 |
| 2           | 2    | 4   | 2 % 2 == 0, 2 % 4 != 0 |
| 4           | 4    | 8   | 4 % 4 == 0, 4 % 8 != 0 |
| 8           | 8    | 16  | 8 % 8 == 0, 8 % 16 != 0 |
| 16          | 16   | 32  | 16 % 16 == 0, 16 % 32 != 0 |
| 32          | 32   | 64  | 32 % 32 == 0, 32 % 64 != 0 |
| 64          | 64   | 128 | 64 % 64 == 0 (capped at 64) |
| 128         | 64   | 192 | Capped at maxSize (64) |

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

1. `getSliceSizeForAbsoluteZ(z)` - Returns maximum candidate size (upper bound based on |z|)
2. `getSliceContainingZ(z)` - Returns the slice containing a z-coordinate
3. `generateSlicesForRange(minZ, maxZ)` - Generates alignment-based slices for a range
4. `selectSlices(cameraZ, minRelativeDepth, maxRelativeDepth)` - Camera selects visible slices

## Benefits

- **O(log n) efficiency**: Covering distance n requires only ~log₂(n) slices
- **Stable boundaries**: Same z always in same slice, no visual jumping
- **Better caching**: Slices reused when camera moves laterally
- **Predictable behavior**: Slice structure is deterministic and globally consistent
- **Proper parallax**: Compositing stage applies depth-based movement
