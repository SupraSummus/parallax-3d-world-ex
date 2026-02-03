# Layer-Based Rendering Architecture

## Overview

The parallax rendering engine uses a geometric progression of slice sizes based on **viewing distance** (distance from camera to slice). This creates the proper parallax effect where:

1. **Near slices** have more detail (smaller sizes, more slices per unit distance)
2. **Far slices** have less detail (larger sizes, fewer slices per unit distance)
3. **Slices follow the camera**, maintaining consistent viewing distance relationships

## Design Principles

### Viewing Distance Based Slicing

Slices are defined based on **viewing distance** (distance from camera), not absolute world coordinates:

```
Viewing Distance:  1    2    4         8                16
                   │────│────│─────────│─────────────────│...
                   │ 1  │ 2  │    4    │        8        │
                   └────┴────┴─────────┴─────────────────┘
                   Geometric slice sizes (size = largest power of 2 ≤ viewing distance)
```

The slicing algorithm achieves **O(log n) slices for distance n**:
1. Slice size = largest power of 2 ≤ viewing distance
2. Each slice covers a range that doubles in size:
   - Viewing distance 1 → size 1 (covers 1-2)
   - Viewing distance 2 → size 2 (covers 2-4)
   - Viewing distance 4 → size 4 (covers 4-8)
   - Viewing distance 8 → size 8 (covers 8-16)
   - etc.
3. Caps at maxSize (64) to prevent extremely large slices
4. **Slices follow the camera** - viewing distance progression is constant

This geometric progression means covering distance n requires only ~log₂(n) slices,
plus a linear term for distances beyond the maxSize cap.

### Why Viewing Distance Based?

The previous design used absolute world coordinates for slice sizes, which had problems:
- A world position far from origin would always have large slices, even when close to camera
- Moving toward objects didn't increase their detail (slice density)
- Missing slices appeared randomly during camera movement

With viewing distance based slicing:
- Nearby objects always have small slices (more detail)
- Moving toward objects increases their slice density (more detail)
- Consistent slice structure regardless of camera position
- Smooth, predictable behavior during movement

### Parallax Effect

The parallax effect comes from:
1. **Near slices** move more relative to camera movement
2. **Far slices** move less relative to camera movement
3. All slices follow the camera, maintaining proper depth perception

### Slice Progression Example

For camera at z=-30 with viewing range 1-200:

| Viewing Distance | World Z | Size | Coverage |
|-----------------|---------|------|----------|
| 1               | -29     | 1    | -29 to -28 |
| 2               | -28     | 2    | -28 to -26 |
| 4               | -26     | 4    | -26 to -22 |
| 8               | -22     | 8    | -22 to -14 |
| 16              | -14     | 16   | -14 to 2 |
| 32              | 2       | 32   | 2 to 34 |
| 64              | 34      | 64   | 34 to 98 |
| 128             | 98      | 64   | 98 to 162 (capped) |

### Cache Strategy

| Movement Type | Cache Behavior |
|---------------|----------------|
| X/Y movement  | All layers cached, only parallax offset changes |
| Z movement (small) | Layers shift with camera, content invalidated |
| Z movement (large) | Layers shift with camera, content invalidated |

### Implementation Notes

1. `selectSlices(cameraZ, minRelativeDepth, maxRelativeDepth)` - Creates slices based on viewing distance
2. `getSliceSizeForViewingDistance(viewingDistance)` - Returns power-of-2 size for given distance
3. Slices are contiguous with no gaps
4. Slice count is consistent for same viewing distance range

## Benefits

- **O(log n) efficiency**: Covering distance n requires only ~log₂(n) slices due to geometric progression
- **Proper parallax**: Near objects have more detail, far objects have less
- **Consistent behavior**: Same slice structure regardless of camera world position
- **No missing slices**: Slices are guaranteed contiguous
- **Proper density**: Moving toward objects increases slice density (more detail)
