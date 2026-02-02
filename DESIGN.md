# Layer-Based Rendering Architecture

## Overview

The parallax rendering engine uses two distinct mechanisms that must be **decoupled** for smooth movement:

1. **World Slicing** - Partitions the 3D world into layers at fixed z-boundaries
2. **View Positioning** - Positions layers on screen based on camera position

## Problem Statement

Previously, these mechanisms were coupled: layer boundaries were calculated relative to the camera z-position. This caused layers to "jump" when moving forward/backward because:
- Layer boundaries shifted with camera movement
- Layers would split, merge, or suddenly appear at different z-positions
- The result was jerky/stepwise motion in the z-direction

Sideways movement (x/y) was already smooth because layers only needed repositioning, not recalculation.

## Design Principles

### Separation of Concerns

```
┌─────────────────────────────────────────────────────────────────┐
│                     World Slicing                                │
│  - Fixed absolute z-boundaries in world space                    │
│  - Power-of-2 sizes aligned to world coordinates                 │
│  - Independent of camera position                                │
│  - Cached and reused across frames                               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     View Positioning                             │
│  - Camera determines which layers are visible                    │
│  - Parallax offset calculated per layer                          │
│  - Smooth interpolation for all movement directions              │
│  - Only regenerates when layers enter/exit view                  │
└─────────────────────────────────────────────────────────────────┘
```

### World Slicing (Camera-Independent)

Layers are defined in **absolute world coordinates**:

```
World Z:  0    1    2    4         8                16
          │────│────│────│─────────│─────────────────│...
          │ 1  │ 1  │ 2  │    4    │        8        │
          └────┴────┴────┴─────────┴─────────────────┘
          Progressive layer sizes (powers of 2)
```

The slicing algorithm:
1. Starts from a fixed minimum z-value (e.g., 0 or world minimum)
2. Uses progressive power-of-2 sizes as z increases
3. Aligns boundaries to size multiples (e.g., size-8 layers start at z=0, 8, 16...)
4. **Does NOT depend on camera position**

### View Positioning (Camera-Dependent)

Given fixed world layers, the view positioning:
1. Determines visible range: `[camera.z + minDepth, camera.z + maxDepth]`
2. Selects layers that overlap with visible range
3. Calculates parallax offset for each layer based on camera position
4. Layers smoothly slide as camera moves in any direction

### Layer Lifecycle

```
Layer State: INACTIVE → VISIBLE → RENDERING → CACHED → VISIBLE → INACTIVE
                 │          │          │          │          │
                 └──────────┼──────────┼──────────┼──────────┘
                         (enters view)       (exits view)
```

- **INACTIVE**: Layer exists in world but not needed for current view
- **VISIBLE**: Layer enters visible range, needs to be rendered
- **RENDERING**: Voxels are projected and cached to off-screen canvas
- **CACHED**: Layer content is reused, only position updates
- **On z-movement**: Different layers become visible, but visible ones stay cached

### Cache Strategy

| Movement Type | Cache Behavior |
|---------------|----------------|
| X/Y movement  | All layers cached, only parallax offset changes |
| Z movement (small) | Most layers cached, edge layers may enter/exit |
| Z movement (large) | More layers invalidated, but core layers reused |

### Implementation Notes

1. `selectSlices(cameraZ, minRelativeDepth, maxRelativeDepth)` - Uses cameraZ to compute visible range, but layer boundaries are aligned to absolute world coordinates
2. Layer boundaries are globally consistent across frames
3. `updateLayers()` determines visibility based on camera.z
4. Cache invalidation only when:
   - World regenerates
   - Canvas resizes
   - Layer enters view for first time

## Benefits

- **Smooth z-movement**: Layers don't jump because boundaries are fixed
- **Better caching**: Same layers reused across frames
- **Predictable behavior**: Layer structure is deterministic
- **Performance**: Less layer regeneration overall
