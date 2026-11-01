import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import App from './App'

// These tests cover the UI; a few voxels render much faster than the full forest.
vi.mock('./lib/forest', async () => {
  const { VoxelGrid } = await import('./lib/voxel-grid')
  return {
    generateForest: () => ({
      grid: VoxelGrid.fromVoxels(Array.from({ length: 50 }, (_, i) => ({ x: i % 5, y: 0, z: i, color: '#4f7a2a', type: 1 }))),
      spawn: { x: 0, y: 3, z: -2 },
    }),
  }
})

const cameraPosition = () =>
  (screen.getByText('Position').nextElementSibling?.textContent ?? '').split(',').map(Number)

describe('App', () => {
  it('renders the title and control panels', () => {
    render(<App />)
    expect(screen.getByText('PARALLAX ENGINE')).toBeInTheDocument()
    expect(screen.getByText('Render Statistics')).toBeInTheDocument()
    expect(screen.getByText('Camera')).toBeInTheDocument()
    expect(screen.getByText('World')).toBeInTheDocument()
    expect(screen.getByText('Layers')).toBeInTheDocument()
  })

  it('renders the scene on mount', () => {
    const { container } = render(<App />)
    expect(container.querySelectorAll('canvas').length).toBeGreaterThan(0)
    expect(screen.getByText('Total Updates').nextElementSibling).not.toHaveTextContent(/^0$/)
  })

  it('hides and re-shows the statistics panel', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Hide statistics' }))
    expect(screen.queryByText('Render Statistics')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Stats/ }))
    expect(screen.getByText('Render Statistics')).toBeInTheDocument()
  })

  it('toggles the layers panel', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /Hide Layers/ }))
    expect(screen.queryByText('Layers')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Show Layers/ }))
    expect(screen.getByText('Layers')).toBeInTheDocument()
  })

  it.each([
    ['w', 2],
    ['s', 2],
    ['d', 0],
    ['a', 0],
    [' ', 1],
    ['Shift', 1],
  ])('moves the camera along one axis while %j is held', async (key, axis) => {
    const sign = ['s', 'a', 'Shift'].includes(key) ? -1 : 1
    render(<App />)
    const start = cameraPosition()

    fireEvent.keyDown(window, { key })
    await waitFor(() => { expect(sign * (cameraPosition()[axis] - start[axis])).toBeGreaterThanOrEqual(1) })
    fireEvent.keyUp(window, { key })

    // Let React flush the state from the last frame, then check movement stopped.
    const settle = () => new Promise(resolve => setTimeout(resolve, 50))
    await settle()
    const moved = cameraPosition()
    expect(moved.filter((_, i) => i !== axis)).toEqual(start.filter((_, i) => i !== axis))
    await settle()
    expect(cameraPosition()).toEqual(moved)
  })

  it('turns with the arrow keys, and then moves forward where it looks', async () => {
    render(<App />)
    const orientation = () => (screen.getByText('Yaw, Pitch').nextElementSibling?.textContent ?? '').split(',').map(parseFloat)
    expect(orientation()).toEqual([0, 0])

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    await waitFor(() => { expect(orientation()[0]).toBeGreaterThanOrEqual(10) })
    fireEvent.keyUp(window, { key: 'ArrowRight' })
    expect(orientation()[1]).toBe(0)

    const start = cameraPosition()
    fireEvent.keyDown(window, { key: 'w' })
    await waitFor(() => { expect(cameraPosition()[2] - start[2]).toBeGreaterThanOrEqual(1) })
    fireEvent.keyUp(window, { key: 'w' })
    // Turned right, so forward also goes towards +x; level, so not up.
    expect(cameraPosition()[0]).toBeGreaterThan(start[0])
    expect(cameraPosition()[1]).toBe(start[1])
  })

  it('ignores unrelated keys', async () => {
    render(<App />)
    const start = cameraPosition()
    fireEvent.keyDown(window, { key: 'q' })
    await new Promise(resolve => setTimeout(resolve, 50))
    fireEvent.keyUp(window, { key: 'q' })
    expect(cameraPosition()).toEqual(start)
  })

  it('lists movement controls', () => {
    render(<App />)
    expect(screen.getByText('W/S - Forward/Back')).toBeInTheDocument()
    expect(screen.getByText('A/D - Left/Right')).toBeInTheDocument()
    expect(screen.getByText('Space/Shift - Up/Down')).toBeInTheDocument()
    expect(screen.getByText('Arrows/Drag - Look around')).toBeInTheDocument()
  })
})
