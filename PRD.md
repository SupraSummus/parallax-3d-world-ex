# Planning Guide

A parallax-based 2.5D rendering engine that renders a full 3D voxel world using progressively-sized cached layers for efficient exploration and visualization, demonstrating innovative rendering techniques through intelligent layer boundaries and depth compositing with a fixed viewing direction.

**Experience Qualities**:
1. **Fluid** - Smooth camera movement and instant visual feedback through cached layer compositing
2. **Hypnotic** - Mesmerizing depth perception as layers slide past each other during exploration
3. **Technical** - Showcases the rendering innovation with visible layer transitions and performance metrics

**Complexity Level**: Complex Application (advanced functionality, likely with multiple views)
This is a sophisticated rendering engine with real-time 3D-to-2D projection, layer management, caching systems, camera controls, and performance optimization. It requires advanced state management and computational geometry.

## Essential Features

**Layer-Based Rendering System with Progressive Slicing**
- Functionality: Renders the 3D world as a series of 2D depth layers that increase in size with distance (powers of 2)
- Purpose: Achieve high performance by grouping distant voxels into larger layers while keeping near voxels detailed
- Trigger: On initial load or when camera moves perpendicular to layers beyond layer boundaries
- Progression: World initialized → Layers generated with power-of-2 boundaries relative to camera → Cached to memory → Composited for display → Reused during movement → Boundaries remain stable for far layers
- Success criteria: Smooth 60fps movement, minimal layer regeneration when moving by 1 unit, far layer boundaries stay fixed probabilistically

**Free Camera Movement (Fixed Direction)**
- Functionality: WASD for horizontal/depth movement, Space/Shift for Y axis, no rotation - fixed viewing direction
- Purpose: Allow exploration of the voxel world while maintaining consistent layer boundaries and viewing axes
- Trigger: Keyboard input for position only
- Progression: Input detected → Camera position updated → Layers repositioned (parallel) or regenerated (perpendicular/crossing boundaries) → Scene composited → Rendered
- Success criteria: Responsive controls, smooth transitions, proper depth perception maintained, far layers remain stable during small movements

**Intelligent Progressive Layer Cache Management**
- Functionality: Generates layers at power-of-2 boundaries (1, 2, 4, 8, 16 units deep), with boundaries rounded to camera position
- Purpose: Minimize layer regeneration - far layers stay stable when moving by 1 unit due to boundary rounding
- Trigger: Camera movement perpendicular to layer planes crosses layer boundaries
- Progression: Camera moves → Layer boundaries calculated based on rounded camera position → Layers outside boundaries discarded → New layers generated → Cache updated
- Success criteria: Cache hits for small movements, layer boundaries aligned to powers of 2, visible layer depth progression

**Voxel World Generation**
- Functionality: Procedurally generates a 3D voxel world with terrain, structures, and variation
- Purpose: Provide interesting geometry to showcase the rendering technique
- Trigger: On application initialization
- Trigger: User can regenerate world via controls
- Progression: Seed selected → Noise functions generate terrain → Structures placed → Trees/features added → World model stored in memory
- Success criteria: Varied, explorable terrain with clear depth differentiation

**Debug Visualization**
- Functionality: Overlay showing FPS, layer count, cache status, camera position, and render statistics
- Purpose: Make the technical innovation visible and measurable
- Trigger: Always visible or toggleable
- Progression: Frame rendered → Stats collected → Overlay updated → Displayed
- Success criteria: Real-time statistics, visible correlation between movement and cache behavior

**Automated Testing Suite**
- Functionality: Comprehensive unit and integration tests for renderer and UI components
- Purpose: Ensure correctness and prevent regressions, especially for progressive layer boundary logic
- Trigger: Developer runs tests manually or in watch mode
- Progression: Tests execute → Assertions verify behavior → Pass/fail feedback → Coverage report generated
- Success criteria: All tests pass, progressive layer slicing tested, fixed-direction rendering verified, >80% code coverage

## Edge Case Handling

- **Rapid Camera Movement**: Throttle layer regeneration, interpolate between cached states to maintain smoothness
- **Memory Constraints**: Limit maximum cached layers, implement LRU eviction policy if memory pressure detected
- **Empty Space**: Render sky gradient or void color when no voxels exist at depth layer
- **Layer Boundary Artifacts**: Use subtle anti-aliasing or dithering at layer transitions to minimize visual discontinuities
- **Extreme Zoom Levels**: Clamp camera distance from world origin to prevent rendering breakdown
- **Initial Load**: Show loading state while world generates and initial layers render

## Design Direction

The design should evoke a technical, experimental aesthetic—like peering into a rendering research lab. Users should feel they're witnessing the inner workings of a clever layer-slicing optimization. The interface should be clean and minimal to let the rendering be the star, with precise typography and data visualization that emphasizes the progressive depth stratification and computational sophistication.

## Color Selection

A dark, technical palette with vibrant accent colors to highlight the layer separation and make the rendering technique visually obvious.

- **Primary Color**: Deep Space Blue (oklch(0.25 0.08 250)) - Creates a dark, technical canvas that makes bright voxels pop
- **Secondary Colors**: 
  - Charcoal Gray (oklch(0.30 0.02 260)) for UI panels and cards
  - Slate (oklch(0.45 0.03 250)) for secondary text and borders
- **Accent Color**: Neon Cyan (oklch(0.75 0.15 195)) - High-tech highlighting for active elements, stats, and layer boundaries
- **Voxel Colors**: Vibrant, saturated colors for world blocks to create strong layer contrast
- **Foreground/Background Pairings**:
  - Primary Background (oklch(0.25 0.08 250)): White text (oklch(0.98 0 0)) - Ratio 12.5:1 ✓
  - Card Background (oklch(0.30 0.02 260)): Light Gray text (oklch(0.90 0 0)) - Ratio 9.8:1 ✓
  - Accent (oklch(0.75 0.15 195)): Dark Blue text (oklch(0.20 0.08 250)) - Ratio 6.2:1 ✓

## Font Selection

A monospace font for technical precision and data display, paired with a geometric sans-serif for UI labels—evoking scientific computing and game development tools.

- **Typographic Hierarchy**:
  - H1 (Title): JetBrains Mono Bold / 32px / tight tracking (-0.02em)
  - H2 (Section Headers): Space Grotesk Bold / 20px / normal tracking
  - Body (UI Labels): Space Grotesk Regular / 14px / normal tracking
  - Data Display: JetBrains Mono Regular / 13px / tabular numbers
  - Debug Stats: JetBrains Mono Regular / 11px / monospace for alignment

## Animations

Animations should emphasize the mechanical nature of the progressive layer system—smooth, linear movements for layer sliding, subtle easing for UI transitions. When layers regenerate due to boundary crossings, the system should feel responsive and deliberate. Camera movement should be immediate and responsive, with clear visual feedback when crossing layer boundaries.

## Component Selection

- **Components**:
  - Card: For stats overlay and control panels with dark, semi-transparent background
  - Button: For world regeneration, view toggles, and control options
  - Separator: To divide stats sections
  - Badge: To show cache status (HIT/MISS), render mode indicators
  - Slider: For adjusting layer spacing, render distance, and other parameters
  - Tabs: To switch between different visualization modes or world types
  
- **Customizations**:
  - Canvas Component: Full-viewport custom canvas for the rendering engine
  - Layer Visualizer: Custom component showing active layers as stacked semi-transparent planes
  - Performance Graph: Custom real-time FPS/frame time chart
  
- **States**:
  - Buttons: Default dark with cyan border, hover brightens background, active shows layer shift effect
  - Interactive Canvas: Cursor changes based on control mode (move vs look)
  - Stats Display: Highlights in cyan when values change significantly
  
- **Icon Selection**:
  - ArrowsOutCardinal: Camera movement controls
  - ArrowClockwise: World regeneration
  - Eye: Toggle debug visualization
  - Cube: Layer/voxel information
  - ChartLine: Performance metrics
  - Crosshair: Camera target/focus indicator
  
- **Spacing**:
  - Canvas: Full viewport with fixed overlay panels
  - Stats overlay: p-4 gap-2 for tight, data-dense display
  - Control panel: p-6 gap-4 for comfortable interaction
  - Grid layouts: gap-3 for related controls
  
- **Mobile**:
  - Touch drag for camera panning (X/Y movement)
  - Two-finger swipe for depth (Z) movement
  - Simplified stats panel (collapsible)
  - Pinch gesture for move speed adjustment
  - Reduced layer count for performance
