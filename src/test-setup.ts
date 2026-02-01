import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

afterEach(() => {
  cleanup()
})

globalThis.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
})) as unknown as typeof ResizeObserver

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
})) as unknown as typeof HTMLCanvasElement.prototype.getContext

globalThis.requestAnimationFrame = vi.fn((cb) => {
  setTimeout(cb, 16)
  return 1
}) as unknown as typeof requestAnimationFrame

globalThis.cancelAnimationFrame = vi.fn() as unknown as typeof cancelAnimationFrame
