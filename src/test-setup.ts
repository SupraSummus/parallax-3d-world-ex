import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

afterEach(() => {
  cleanup()
})

global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}))

HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
  fillStyle: '',
  strokeStyle: '',
  lineWidth: 1,
  fillRect: vi.fn(),
  strokeRect: vi.fn(),
  clearRect: vi.fn(),
  drawImage: vi.fn(),
  beginPath: vi.fn(),
  closePath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  arc: vi.fn(),
  fill: vi.fn(),
  stroke: vi.fn(),
  save: vi.fn(),
  restore: vi.fn(),
  translate: vi.fn(),
  rotate: vi.fn(),
  scale: vi.fn(),
  globalAlpha: 1,
  canvas: document.createElement('canvas'),
})) as CanvasRenderingContext2D

global.requestAnimationFrame = vi.fn((cb) => {
  setTimeout(cb, 16)
  return 1
})

global.cancelAnimationFrame = vi.fn()
