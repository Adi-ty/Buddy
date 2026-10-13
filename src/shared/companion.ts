export interface CompanionPosition {
  displayId: number
  displayUuid: string | null
  // Fractions of the available travel, independent of display scale and card size.
  x: number
  y: number
}

export const COMPANION_MOVES = ['start', 'finish', 'cancel', 'left', 'right', 'up', 'down'] as const
export type CompanionMove = (typeof COMPANION_MOVES)[number]

export function isCompanionPosition(value: unknown): value is CompanionPosition {
  if (!value || typeof value !== 'object') return false
  const position = value as CompanionPosition
  return (
    Number.isInteger(position.displayId) &&
    (position.displayUuid === null ||
      (typeof position.displayUuid === 'string' && position.displayUuid.length <= 256)) &&
    [position.x, position.y].every(
      (fraction) =>
        typeof fraction === 'number' && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1,
    )
  )
}
