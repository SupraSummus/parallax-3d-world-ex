# Layer-Based Rendering Architecture

## Overview

The parallax rendering engine uses **two distinct mechanisms** that work together:

### Mechanism 1: World Slice Availability (Camera-Independent)
- At any depth, **multiple slice sizes are available** based on alignment constraints
- A slice of size N can start at depth z if `z % N == 0`
- Valid sizes form a geometric progression: 1, 2, 4, 8, 16, 32, 64 (powers of 2)
- The world **provides slices on request**, respecting alignment constraints

### Mechanism 2: Camera Slice Selection (Camera-Dependent)
- Camera **requests slices** based on viewing distance
- Near camera → request small slices (more detail)
- Far from camera → request large slices (efficiency)
- The world provides the **smallest valid slice** that satisfies the request
- Slices are rendered flat (orthographic) and composited with parallax offset

## Design Principles

### World Slice Availability (Mechanism 1)

At any depth z, multiple slice sizes are **available** based on alignment:

```
Alignment Rule:
- Size-1 slices can start at any integer z
- Size-2 slices can only start at z % 2 == 0
- Size-4 slices can only start at z % 4 == 0
- Size-N slices can only start at z % N == 0

Example: At z=0, ALL sizes are available (0 % N == 0 for all N)
Example: At z=8, sizes 1, 2, 4, 8 are available (8 % 8 == 0)
Example: At z=6, sizes 1, 2 are available (6 % 4 != 0)
```

The world provides slices via `getSliceAtDepth(z, minSize)`:
- **Request**: "Give me a slice starting at z with size >= minSize"
- **Response**: Smallest valid size >= minSize that respects alignment
- If no valid size >= minSize exists, return the largest available

### Camera Selection (Mechanism 2 - Camera-Dependent)

The camera iterates through the visible range, requesting slices:

```
Algorithm:
1. Start at nearZ = cameraZ + minRelativeDepth
2. Compute minSize based on viewing distance (geometric progression)
3. Request slice from world: getSliceAtDepth(currentZ, minSize)
4. World provides slice (possibly larger due to alignment)
5. Move to nextZ = slice.depth + slice.size
6. Repeat until farZ is reached

Viewing Distance → minSize:
- Distance 1-2  → minSize 1
- Distance 2-4  → minSize 2
- Distance 4-8  → minSize 4
- Distance 8-16 → minSize 8
- etc.
```

### Slice Progression Example

Camera at z=0, visible range 1-200:

| Viewing Dist | minSize | World Z | Available Sizes | Provided Size |
|-------------|---------|---------|-----------------|---------------|
| 1           | 1       | 1       | 1               | 1             |
| 2           | 2       | 2       | 1, 2            | 2             |
| 4           | 4       | 4       | 1, 2, 4         | 4             |
| 8           | 8       | 8       | 1, 2, 4, 8      | 8             |
| 16          | 16      | 16      | 1, 2, 4, 8, 16  | 16            |
| 32          | 32      | 32      | 1, 2, ..., 32   | 32            |
| 64          | 64      | 64      | 1, 2, ..., 64   | 64            |
| 128         | 64      | 128     | 1, 2, ..., 64   | 64            |

Camera at z=-67, visible range 1-200:

| Viewing Dist | minSize | World Z | Available Sizes | Provided Size |
|-------------|---------|---------|-----------------|---------------|
| 1           | 1       | -66     | 1, 2            | 1             |
| 2           | 1       | -65     | 1               | 1             |
| 3           | 2       | -64     | 1, 2, ..., 64   | 2             |
| 5           | 4       | -62     | 1, 2            | 2             |
| 7           | 4       | -60     | 1, 2, 4         | 4             |
| 11          | 8       | -56     | 1, 2, 4, 8      | 8             |
| 19          | 16      | -48     | 1, 2, ..., 16   | 16            |
| 35          | 32      | -32     | 1, 2, ..., 32   | 32            |
| 67          | 64      | 0       | 1, 2, ..., 64   | 64            |
| 131         | 64      | 64      | 1, 2, ..., 64   | 64            |

### Layer Lifecycle

```
Layer State: REQUESTED → FLAT_RENDER → CACHED → COMPOSITED
                 │            │           │          │
      (Camera requests) (Orthographic) (Reused)  (CSS transform applied)
```

- **REQUESTED**: Camera requests slice based on viewing distance
- **FLAT_RENDER**: Slice voxels rendered orthographically to a layer canvas
- **CACHED**: Rendered slice content reused across frames
- **COMPOSITED**: Layer canvas positioned via CSS `transform: translate3d()` for GPU-accelerated parallax

### Browser-Based Compositing

Each layer is a separate `<canvas>` DOM element positioned with CSS transforms:
- Layer canvases use `will-change: transform` to promote to compositor layers
- Parallax offset applied via `transform: translate3d(offsetX, offsetY, 0)` (GPU-accelerated)
- Fog depth effect uses overlay `<div>` elements between layers
- When only X/Y camera movement occurs, only CSS transforms update—no canvas re-rendering needed

### Cache Strategy

| Movement Type | Slice Behavior | Cache Behavior |
|---------------|----------------|----------------|
| X/Y movement  | Same slices (same viewing distances) | Cached, only parallax offset changes |
| Z movement (small) | Slice sizes may change slightly | Some cache invalidation |
| Z movement (large) | Many slices change size | More cache invalidation |

### Key Insight: Why Camera-Dependent Slice Sizing?

With camera-dependent sizing:
- **Near camera**: Small slices = more detail where you can see it
- **Far from camera**: Large slices = efficiency, detail not visible anyway
- **Alignment respected**: Slices always aligned to valid boundaries
- **Contiguous coverage**: No gaps, slices tile perfectly

This achieves:
- **O(log n) efficiency**: ~log₂(n) slices to cover distance n
- **Detail where needed**: Small slices near camera
- **Efficiency**: Large slices far from camera

### Implementation Functions

1. `getSliceAtDepth(z, minSize)` - World provides smallest valid slice >= minSize
2. `getMinSizeForViewingDistance(dist)` - Camera computes minSize based on distance
3. `selectSlices(cameraZ, minRelativeDepth, maxRelativeDepth)` - Main selection function

## Benefits

- **O(log n) efficiency**: Covering distance n requires only ~log₂(n) slices
- **Detail near camera**: Small slices where you can see details
- **Efficiency far away**: Large slices where detail doesn't matter
- **Alignment respected**: Slices always properly aligned
- **Contiguous coverage**: No gaps between slices
- **Proper parallax**: Compositing stage applies depth-based movement
