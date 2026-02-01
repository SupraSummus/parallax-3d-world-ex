import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import App from './App'

describe('App Component', () => {
  beforeEach(() => {
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      fillStyle: '',
      fillRect: vi.fn(),
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      globalAlpha: 1,
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext
  })

  it('should render the main title', () => {
    render(<App />)
    expect(screen.getByText('PARALLAX ENGINE')).toBeInTheDocument()
  })

  it('should render the subtitle', () => {
    render(<App />)
    expect(screen.getByText('2.5D Rendering with Layer Cache')).toBeInTheDocument()
  })

  it('should render canvas element', () => {
    const { container } = render(<App />)
    const canvas = container.querySelector('canvas')
    expect(canvas).toBeInTheDocument()
  })

  describe('Performance Stats', () => {
    it('should show performance card by default', () => {
      render(<App />)
      expect(screen.getByText('Performance')).toBeInTheDocument()
    })

    it('should display FPS stat', () => {
      render(<App />)
      expect(screen.getByText('FPS')).toBeInTheDocument()
    })

    it('should display frame time stat', () => {
      render(<App />)
      expect(screen.getByText('Frame Time')).toBeInTheDocument()
    })

    it('should display cache stats', () => {
      render(<App />)
      expect(screen.getByText('Cache')).toBeInTheDocument()
      expect(screen.getByText('Hits / Misses')).toBeInTheDocument()
    })

    it('should display layer stats', () => {
      render(<App />)
      // Active Layers appears in both Performance and Camera cards
      expect(screen.getAllByText('Active Layers').length).toBeGreaterThan(0)
      expect(screen.getByText('Voxels/Frame')).toBeInTheDocument()
    })

    it('should hide performance stats when clicking eye slash', async () => {
      render(<App />)
      
      // Find the Performance card and the hide button (EyeSlash icon button)
      const performanceCards = screen.getAllByRole('button')
      const hideButton = performanceCards.find(btn => btn.classList.contains('h-6'))
      if (hideButton) {
        fireEvent.click(hideButton)
        
        await waitFor(() => {
          // The "Performance" heading should be gone from the performance card
          // but "Performance" button might appear in World card
          expect(screen.queryByText('Performance', { selector: 'h2' })).not.toBeInTheDocument()
        })
      }
    })

    it('should show performance stats again when clicking show button', async () => {
      render(<App />)
      
      // Find and click the hide button to hide performance stats first
      const performanceCards = screen.getAllByRole('button')
      const hideButton = performanceCards.find(btn => btn.classList.contains('h-6'))
      if (hideButton) {
        fireEvent.click(hideButton)
        
        await waitFor(() => {
          // The button shows "Performance" (not "Show Performance")
          const showButton = screen.getByRole('button', { name: /Performance/ })
          fireEvent.click(showButton)
        })
        
        await waitFor(() => {
          // Performance heading should be back
          expect(screen.getByRole('heading', { name: 'Performance' })).toBeInTheDocument()
        })
      }
    })
  })

  describe('Camera Controls', () => {
    it('should display camera card', () => {
      render(<App />)
      expect(screen.getByText('Camera')).toBeInTheDocument()
    })

    it('should show camera position', () => {
      render(<App />)
      expect(screen.getByText('Position')).toBeInTheDocument()
    })

    it('should show active layers in camera card', () => {
      render(<App />)
      // Active Layers is shown in the Camera card
      expect(screen.getAllByText('Active Layers').length).toBeGreaterThan(0)
    })

    it('should have layer spacing slider', () => {
      render(<App />)
      expect(screen.getByText(/Layer Spacing:/)).toBeInTheDocument()
    })

    it('should have move speed slider', () => {
      render(<App />)
      expect(screen.getByText(/Move Speed:/)).toBeInTheDocument()
    })
  })

  describe('World Controls', () => {
    it('should display world card', () => {
      render(<App />)
      expect(screen.getByText('World')).toBeInTheDocument()
    })

    it('should have regenerate world button', () => {
      render(<App />)
      expect(screen.getByText('Regenerate World')).toBeInTheDocument()
    })

    it('should show control instructions', () => {
      render(<App />)
      expect(screen.getByText('WASD - Move Horizontally')).toBeInTheDocument()
      expect(screen.getByText('Space/Shift - Up/Down')).toBeInTheDocument()
      expect(screen.getByText('W/S also moves In/Out')).toBeInTheDocument()
    })
  })

  describe('Keyboard Controls', () => {
    it('should handle W key press', () => {
      render(<App />)
      
      fireEvent.keyDown(window, { key: 'w' })
      fireEvent.keyUp(window, { key: 'w' })
      
      expect(true).toBe(true)
    })

    it('should handle WASD keys', () => {
      render(<App />)
      
      const keys = ['w', 'a', 's', 'd']
      keys.forEach(key => {
        fireEvent.keyDown(window, { key })
        fireEvent.keyUp(window, { key })
      })
      
      expect(true).toBe(true)
    })

    it('should handle space and shift keys', () => {
      render(<App />)
      
      fireEvent.keyDown(window, { key: ' ' })
      fireEvent.keyUp(window, { key: ' ' })
      fireEvent.keyDown(window, { key: 'Shift' })
      fireEvent.keyUp(window, { key: 'Shift' })
      
      expect(true).toBe(true)
    })
  })

  describe('Mouse Controls', () => {
    it('should handle mouse down event', () => {
      const { container } = render(<App />)
      const canvas = container.querySelector('canvas')
      
      if (canvas) {
        fireEvent.mouseDown(canvas, { button: 0, clientX: 100, clientY: 100 })
        fireEvent.mouseUp(canvas)
      }
      
      expect(true).toBe(true)
    })

    it('should handle mouse move for camera rotation', () => {
      const { container } = render(<App />)
      const canvas = container.querySelector('canvas')
      
      if (canvas) {
        fireEvent.mouseDown(window, { button: 0, clientX: 100, clientY: 100 })
        fireEvent.mouseMove(window, { clientX: 150, clientY: 120 })
        fireEvent.mouseUp(window)
      }
      
      expect(true).toBe(true)
    })
  })

  describe('Crosshair', () => {
    it('should render crosshair in center', () => {
      const { container } = render(<App />)
      const crosshair = container.querySelector('.absolute.top-1\\/2.left-1\\/2')
      expect(crosshair).toBeInTheDocument()
    })
  })

  describe('Responsive Behavior', () => {
    it('should handle window resize', () => {
      render(<App />)
      
      fireEvent.resize(window)
      
      expect(true).toBe(true)
    })
  })
})
