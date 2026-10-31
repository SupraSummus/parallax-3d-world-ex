import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import App from './App'

const cameraPosition = () => screen.getByText('Position').nextElementSibling?.textContent

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
    ['w', '0.0, 15.0, -30.0', /^0\.0, 15\.0, -2\d\.\d$/],
    ['d', '0.0, 15.0, -30.0', /^[1-9]\d*\.\d, 15\.0, -30\.0$/],
    [' ', '0.0, 15.0, -30.0', /^0\.0, (1[6-9]|[2-9]\d)\.\d, -30\.0$/],
  ])('moves the camera while %j is held', async (key, before, after) => {
    render(<App />)
    expect(cameraPosition()).toBe(before)

    fireEvent.keyDown(window, { key })
    await waitFor(() => { expect(cameraPosition()).toMatch(after) })
    fireEvent.keyUp(window, { key })

    // Let React flush the state from the last frame, then check movement stopped.
    const settle = () => new Promise(resolve => setTimeout(resolve, 50))
    await settle()
    const stopped = cameraPosition()
    await settle()
    expect(cameraPosition()).toBe(stopped)
  })

  it('ignores unrelated keys', async () => {
    render(<App />)
    fireEvent.keyDown(window, { key: 'q' })
    await new Promise(resolve => setTimeout(resolve, 50))
    fireEvent.keyUp(window, { key: 'q' })
    expect(cameraPosition()).toBe('0.0, 15.0, -30.0')
  })

  it('lists movement controls', () => {
    render(<App />)
    expect(screen.getByText('W/S - Forward/Back')).toBeInTheDocument()
    expect(screen.getByText('A/D - Left/Right')).toBeInTheDocument()
    expect(screen.getByText('Space/Shift - Up/Down')).toBeInTheDocument()
  })
})
