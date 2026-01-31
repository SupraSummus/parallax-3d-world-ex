# Parallax Voxel Engine - Testing Guide

## Running Tests

This project includes comprehensive automated tests for the rendering engine and UI components.

### Quick Start

```bash
# Run all tests
npx vitest

# Run tests in watch mode (recommended for development)
npx vitest --watch

# Run tests with coverage report
npx vitest --coverage

# Run tests once (CI mode)
npx vitest run
```

### Test Structure

#### Renderer Tests (`src/lib/renderer.test.ts`)
Tests the core rendering engine functionality:
- **World Generation**: Ensures voxel world generates consistently from seeds
- **Camera Management**: Tests camera position and rotation updates
- **Cache Management**: Validates layer caching and invalidation (including the rotation fix)
- **Layer Management**: Tests layer creation and spacing
- **Performance Tracking**: Ensures FPS and frame time tracking works
- **Integration Tests**: Complete exploration workflows

#### Component Tests (`src/App.test.tsx`)
Tests the UI and user interactions:
- Component rendering (title, canvas, cards)
- Performance stats display and toggle
- Camera controls and sliders
- World controls
- Keyboard input handling (WASD, Space, Shift)
- Mouse controls for camera rotation

### Key Tests for Rotation Fix

The following tests specifically validate the rotation refresh fix:

```typescript
// renderer.test.ts
it('should refresh view when rotating horizontally')
it('should refresh view when rotating vertically')
it('should not refresh for tiny rotation changes')
it('should handle combined rotation and movement')
```

These tests ensure that:
1. Camera rotation triggers cache invalidation
2. Layers are re-rendered when rotation changes
3. Small rotation changes don't cause unnecessary cache misses
4. Combined rotation + movement works correctly

### Coverage

Run `npx vitest --coverage` to see test coverage. The current tests cover:
- World generation logic
- Camera controls and transformations
- Layer caching and invalidation
- Performance tracking
- User input handling
- UI component rendering

### Continuous Testing

For best developer experience:
1. Run `npx vitest --watch` in a terminal
2. Tests will automatically re-run when you modify code
3. Focus on failing tests with patterns: `npx vitest --watch --testNamePattern="rotation"`

## Bug Fix: Rotation Not Refreshing View

### The Problem
When dragging the mouse to rotate the camera, the cached layers were not being invalidated, causing the view to remain static despite rotation changes.

### The Solution
Updated `renderer.ts` line 172-179 to check for rotation changes in addition to position changes:

```typescript
private needsCacheRefresh(): boolean {
  const threshold = this.layerSpacing * 0.5
  const positionChanged = Math.abs(this.camera.z - this.lastCachePosition.z) > threshold
  const rotationChanged = 
    Math.abs(this.camera.rotationY - this.lastCachePosition.rotationY) > 0.01 ||
    Math.abs(this.camera.rotationX - this.lastCachePosition.rotationX) > 0.01
  return positionChanged || rotationChanged
}
```

### Testing the Fix
1. Run the app
2. Drag the mouse to rotate the camera
3. The view should now update smoothly showing different voxels
4. Check the debug panel - cache misses should increase when rotating
5. Run `npx vitest --testNamePattern="rotation"` to verify automated tests pass

## Development Workflow

### Recommended Process
1. **Start dev server**: `npm run dev`
2. **Start tests in watch mode**: `npx vitest --watch`
3. Make code changes
4. Tests automatically re-run
5. Check both test results and visual output in browser
6. Commit when tests pass

### Adding New Tests
1. For renderer logic: Add to `src/lib/renderer.test.ts`
2. For UI components: Add to `src/App.test.tsx`
3. Follow existing test patterns
4. Ensure tests are isolated and don't depend on each other

### Test-Driven Development
For new features:
1. Write failing test first
2. Implement feature
3. Verify test passes
4. Refactor if needed
5. Run full test suite to ensure no regressions

## Common Testing Patterns

### Testing Renderer Changes
```typescript
renderer.render()
const stats1 = renderer.getStats()

// Make change
renderer.setCamera({ rotationY: Math.PI / 2 })
renderer.render()
const stats2 = renderer.getStats()

// Verify expected outcome
expect(stats2.cacheMisses).toBeGreaterThan(stats1.cacheMisses)
```

### Testing UI Interactions
```typescript
render(<App />)

const button = screen.getByText('Regenerate World')
fireEvent.click(button)

await waitFor(() => {
  // Assert expected state change
})
```

## Performance Testing

While automated tests verify correctness, manual performance testing is recommended:

1. Check FPS stays above 30 in debug panel
2. Verify cache hit rate increases during lateral movement
3. Confirm smooth rotation with mouse drag
4. Test on different devices/browsers if possible

## CI/CD Integration

To add tests to CI pipeline:
```yaml
- name: Run tests
  run: npx vitest run

- name: Run tests with coverage
  run: npx vitest run --coverage
```
