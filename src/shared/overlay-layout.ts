import type { OverlayDisplay, Rect } from './contracts'

// The camera is part of this 320-point footprint, not extra width added to it.
// Keep at least 52 points per wing; otherwise use the below-menu fallback.
export function compactNotchBounds(display: OverlayDisplay): Rect | null {
  const { camera, auxiliaryLeft: left, auxiliaryRight: right } = display
  if (!camera || !left || !right) return null
  const wing = Math.floor((320 - Math.ceil(camera.width)) / 2)
  const height = Math.floor(Math.min(camera.height, left.height, right.height, 40))
  if (wing < 52 || height < 28) return null
  const x = Math.floor(camera.x - wing)
  const end = Math.ceil(camera.x + camera.width + wing)
  if (x < left.x || end > right.x + right.width || end - x > 320) return null
  if (left.y !== camera.y || right.y !== camera.y) return null
  return { x, y: camera.y, width: end - x, height }
}

export function matchesBounds(expected: Rect, actual: Rect | null | undefined): boolean {
  return Boolean(
    actual &&
    (['x', 'y', 'width', 'height'] as const).every(
      (key) => Math.abs(actual[key] - expected[key]) < 1,
    ),
  )
}
