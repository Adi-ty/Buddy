import type { Display } from 'electron'
import type { OverlayDisplay, Rect } from '../shared/contracts'

function validRect(rect: Rect): boolean {
  return (
    [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
    rect.width > 0 &&
    rect.height > 0
  )
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x - 1 &&
    inner.y >= outer.y - 1 &&
    inner.x + inner.width <= outer.x + outer.width + 1 &&
    inner.y + inner.height <= outer.y + outer.height + 1
  )
}

// Electron already returns bounds and work areas in device-independent points.
export function mapDisplays(displays: readonly Display[]): OverlayDisplay[] {
  return displays
    .filter(
      (display) =>
        display.id !== -1 &&
        validRect(display.bounds) &&
        validRect(display.workArea) &&
        contains(display.bounds, display.workArea),
    )
    .map((display) => ({
      id: display.id,
      bounds: { ...display.bounds },
      workArea: { ...display.workArea },
    }))
}

export function safeActualBounds(display: OverlayDisplay, actual: Rect): boolean {
  return validRect(actual) && contains(display.workArea, actual)
}
