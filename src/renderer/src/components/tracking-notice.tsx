import type { BuddySnapshot } from '@shared/contracts'
import { Notice } from './ui/notice'

export function TrackingNotice({ tracking }: { tracking: BuddySnapshot['tracking'] }) {
  const losses = [
    tracking.droppedObservations
      ? `${tracking.droppedObservations} activity updates were not recorded`
      : '',
    tracking.capacityEvictions
      ? `${tracking.capacityEvictions} live session records were removed at capacity`
      : '',
  ].filter(Boolean)
  const text = [
    tracking.message,
    losses.length ? `${losses.join('; ')}. Some session states may be incomplete.` : null,
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <Notice
      className="mb-4"
      message={
        text
          ? { text, error: ['paused', 'unavailable'].includes(tracking.phase) || losses.length > 0 }
          : null
      }
    />
  )
}
