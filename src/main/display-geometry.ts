import type { Display } from 'electron'
import type { OverlayDisplay, Rect } from '../shared/contracts'

interface NativeDisplay {
  id: number
  uuid?: string
  name: string
  builtIn: boolean
  frame: Rect
  visibleFrame: Rect
  backingScaleFactor: number
  safeAreaInsets: { top: number; left: number; bottom: number; right: number }
  auxiliaryLeft?: Rect
  auxiliaryRight?: Rect
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
function validRect(value: unknown): value is Rect {
  return (
    isRecord(value) &&
    finite(value.x) &&
    finite(value.y) &&
    finite(value.width) &&
    finite(value.height) &&
    value.width > 0 &&
    value.height > 0
  )
}

function validInsets(value: unknown): boolean {
  return (
    isRecord(value) &&
    ['top', 'left', 'bottom', 'right'].every((key) => finite(value[key]) && value[key] >= 0)
  )
}

export function parseNativeDisplays(output: string): NativeDisplay[] {
  const data: unknown = JSON.parse(output)
  if (
    !isRecord(data) ||
    data.version !== 1 ||
    !Array.isArray(data.displays) ||
    data.displays.length === 0 ||
    data.displays.length > 32
  )
    throw new Error('Invalid display snapshot')
  const ids = new Set<number>()
  for (const display of data.displays) {
    if (
      !isRecord(display) ||
      !Number.isInteger(display.id) ||
      !finite(display.id) ||
      display.id <= 0 ||
      ids.has(display.id) ||
      typeof display.name !== 'string' ||
      display.name.length > 512 ||
      typeof display.builtIn !== 'boolean' ||
      !validRect(display.frame) ||
      !validRect(display.visibleFrame) ||
      !finite(display.backingScaleFactor) ||
      display.backingScaleFactor <= 0 ||
      !validInsets(display.safeAreaInsets) ||
      (display.uuid !== undefined && typeof display.uuid !== 'string') ||
      (display.auxiliaryLeft !== undefined && !validRect(display.auxiliaryLeft)) ||
      (display.auxiliaryRight !== undefined && !validRect(display.auxiliaryRight))
    ) {
      throw new Error('Invalid native display record')
    }
    ids.add(display.id)
  }
  return data.displays as NativeDisplay[]
}

// Both APIs use logical coordinates, with opposite Y axes. Translate within the
// matched display, so negative origins and primary-display changes are safe.
export function nativeRectToElectron(rect: Rect, nativeFrame: Rect, electronBounds: Rect): Rect {
  const sx = electronBounds.width / nativeFrame.width
  const sy = electronBounds.height / nativeFrame.height
  return {
    x: electronBounds.x + (rect.x - nativeFrame.x) * sx,
    y: electronBounds.y + (nativeFrame.y + nativeFrame.height - rect.y - rect.height) * sy,
    width: rect.width * sx,
    height: rect.height * sy,
  }
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x - 1 &&
    inner.y >= outer.y - 1 &&
    inner.x + inner.width <= outer.x + outer.width + 1 &&
    inner.y + inner.height <= outer.y + outer.height + 1
  )
}

export function matchDisplays(native: NativeDisplay[], electron: Display[]): OverlayDisplay[] {
  return native.flatMap((display) => {
    const matched = electron.find((candidate) => candidate.id === display.id)
    // Rotation and unexpected coordinate ratios are unverified. Never infer a
    // notch from a process, model name, resolution, or backing pixel multiplier.
    if (
      !matched ||
      matched.rotation !== 0 ||
      Math.abs(matched.bounds.width / display.frame.width - 1) > 0.01 ||
      Math.abs(matched.bounds.height / display.frame.height - 1) > 0.01 ||
      Math.abs(matched.scaleFactor - display.backingScaleFactor) > 0.01
    )
      return []
    const convert = (rect: Rect) => nativeRectToElectron(rect, display.frame, matched.bounds)
    const left = display.auxiliaryLeft ? convert(display.auxiliaryLeft) : null
    const right = display.auxiliaryRight ? convert(display.auxiliaryRight) : null
    const safeTop = (display.safeAreaInsets.top * matched.bounds.height) / display.frame.height
    if (
      safeTop > matched.bounds.height / 3 ||
      !contains(matched.bounds, matched.workArea) ||
      (left && !contains(matched.bounds, left)) ||
      (right && !contains(matched.bounds, right))
    )
      return []
    let camera: Rect | null = null
    if (safeTop > 0) {
      // An inset without both auxiliary regions is ambiguous; keep the overlay hidden.
      if (!left || !right || left.x + left.width >= right.x) return []
      camera = {
        x: left.x + left.width,
        y: matched.bounds.y,
        width: right.x - left.x - left.width,
        height: safeTop,
      }
    }
    return [
      {
        id: display.id,
        uuid: display.uuid ?? null,
        name: display.name,
        builtIn: display.builtIn,
        bounds: matched.bounds,
        workArea: matched.workArea,
        scaleFactor: matched.scaleFactor,
        safeTop,
        camera,
        auxiliaryLeft: left,
        auxiliaryRight: right,
      },
    ]
  })
}

export function shelfBounds(display: OverlayDisplay, expanded: boolean): Rect | null {
  const width = Math.min(expanded ? 600 : 320, display.workArea.width - 24)
  const height = expanded ? 470 : 60
  const y = Math.ceil(Math.max(display.bounds.y + display.safeTop, display.workArea.y) + 6)
  if (width < 280 || y + height > display.workArea.y + display.workArea.height - 6) return null
  const center = display.camera
    ? display.camera.x + display.camera.width / 2
    : display.bounds.x + display.bounds.width / 2
  return {
    x: Math.round(
      Math.max(
        display.workArea.x + 12,
        Math.min(center - width / 2, display.workArea.x + display.workArea.width - width - 12),
      ),
    ),
    y,
    width: Math.floor(width),
    height,
  }
}

export function safeActualBounds(display: OverlayDisplay, actual: Rect): boolean {
  return (
    contains(display.workArea, actual) &&
    actual.y >= display.bounds.y + display.safeTop &&
    (!display.camera || actual.y >= display.camera.y + display.camera.height)
  )
}
