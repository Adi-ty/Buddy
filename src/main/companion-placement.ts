import type { CompanionPosition } from '../shared/companion'
import type { OverlayDisplay, Rect } from '../shared/contracts'

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(value, max))

function usableArea(display: OverlayDisplay): Rect {
  const top = Math.max(display.workArea.y, display.bounds.y + display.safeTop)
  return {
    x: Math.ceil(display.workArea.x + 12),
    y: Math.ceil(top + 12),
    width: Math.floor(display.workArea.width - 24),
    height: Math.floor(display.workArea.y + display.workArea.height - top - 24),
  }
}

export function companionBounds(
  display: OverlayDisplay,
  expanded: boolean,
  position: Pick<CompanionPosition, 'x' | 'y'> = { x: 1, y: 1 },
): Rect | null {
  const area = usableArea(display)
  const width = Math.min(expanded ? 440 : 320, area.width)
  const height = Math.min(expanded ? 440 : 60, area.height)
  if (width < 280 || height < (expanded ? 240 : 60)) return null
  return {
    x: Math.round(area.x + (area.width - width) * clamp(position.x, 0, 1)),
    y: Math.round(area.y + (area.height - height) * clamp(position.y, 0, 1)),
    width,
    height,
  }
}

export function companionPosition(display: OverlayDisplay, bounds: Rect): CompanionPosition {
  const area = usableArea(display)
  return {
    displayId: display.id,
    displayUuid: display.uuid,
    x: clamp((bounds.x - area.x) / Math.max(1, area.width - bounds.width), 0, 1),
    y: clamp((bounds.y - area.y) / Math.max(1, area.height - bounds.height), 0, 1),
  }
}

export function companionDisplay(
  displays: readonly OverlayDisplay[],
  position: CompanionPosition | null,
): OverlayDisplay | undefined {
  const saved =
    position &&
    displays.find((display) =>
      position.displayUuid
        ? display.uuid === position.displayUuid
        : display.id === position.displayId,
    )
  return saved || displays.find((display) => display.builtIn) || displays[0]
}
