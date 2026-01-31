# Planning Guide

A parallax-based 2.5D rendering engine that renders a full 3D voxel world using cached layers for efficient exploration and visualization, demonstrating innovative rendering techniques through layer reuse and intelligent depth compositing.

**Experience Qualities**:
1. **Fluid** - Smooth camera movement and instant visual feedback through cached layer compositing
2. **Hypnotic** - Mesmerizing depth perception as layers slide past each other during exploration
3. **Technical** - Showcases the rendering innovation with visible layer transitions and performance metrics

**Complexity Level**: Complex Application (advanced functionality, likely with multiple views)
This is a sophisticated rendering engine with real-time 3D-to-2D projection, layer management, caching systems, camera controls, and performance optimization. It requires advanced state management and computational geometry.

## Essential Features

**Layer-Based Rendering System**
- Functionality: Renders the 3D world as a series of 2D depth layers that are cached and reused
- Purpose: Achieve high performance by avoiding full 3D rendering while maintaining spatial accuracy
- Trigger: On initial load and when camera moves perpendicular to layers
- Progression: World initialized → Layers generated at depth intervals → Cached to memory → Composited for display → Reused during parallel movement
- Success criteria: Smooth 60fps movement, visible layer separation, minimal re-rendering during lateral camera motion

**Free Camera Movement**
- Functionality: WASD for XZ plane movement, Space/Shift for Y axis, mouse drag for look direction
- Purpose: Allow unrestricted exploration of the voxel world to test rendering under all conditions
- Trigger: Keyboard input for position, mouse drag for rotation
- Progression: Input detected → Camera position/rotation updated → Layers repositioned (parallel) or regenerated (perpendicular) → Scene composited → Rendered
- Success criteria: Responsive controls, smooth transitions, proper depth perception maintained

**Intelligent Layer Cache Management**
- Functionality: Generates and caches layers at specific depth intervals, regenerates only when necessary
- Purpose: Minimize computational cost by reusing rendered layers during camera translation
- Trigger: Camera movement perpendicular to layer planes exceeds threshold
- Progression: Camera moves → Distance from cache origin calculated → If threshold exceeded, layers regenerated → Cache updated → Old layers discarded
- Success criteria: Cache hits visible in debug overlay, performance improvement measurable

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

## Edge Case Handling

- **Rapid Camera Movement**: Throttle layer regeneration, interpolate between cached states to maintain smoothness
- **Memory Constraints**: Limit maximum cached layers, implement LRU eviction policy if memory pressure detected
- **Empty Space**: Render sky gradient or void color when no voxels exist at depth layer
- **Layer Boundary Artifacts**: Use subtle anti-aliasing or dithering at layer transitions to minimize visual discontinuities
- **Extreme Zoom Levels**: Clamp camera distance from world origin to prevent rendering breakdown
- **Initial Load**: Show loading state while world generates and initial layers render

## Design Direction

The design should evoke a technical, experimental aesthetic—like peering into a rendering research lab. Users should feel they're witnessing the inner workings of a clever optimization technique. The interface should be clean and minimal to let the rendering be the star, with precise typography and data visualization that emphasizes the computational sophistication.

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

Animations should emphasize the mechanical nature of the layer system—smooth, linear movements for layer sliding, subtle easing for UI transitions. When layers regenerate, a brief flicker or rebuild animation makes the caching system visible. Camera movement should be immediate and responsive with no artificial smoothing that might hide the rendering technique.

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
  - Touch drag for camera rotation
  - Virtual joystick overlay for movement (bottom-left)
  - Simplified stats panel (collapsible)
  - Pinch-to-zoom for layer spacing adjustment
  - Reduced layer count for performance
