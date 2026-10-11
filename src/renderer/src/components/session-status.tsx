import type { SessionRecord } from '@shared/contracts'
import { sessionSignal, sessionStatusLabels } from '@shared/sessions'
import { Badge } from './ui/badge'
import { cn } from '@/lib/utils'

export function SessionStatus({
  status,
  compact = false,
}: {
  status: SessionRecord['status']
  compact?: boolean
}) {
  const label = sessionStatusLabels[status]
  if (compact)
    return (
      <span className={cn('status-dot', `status-dot-${status}`)} title={label}>
        <span className="sr-only">{label}</span>
      </span>
    )
  return (
    <Badge variant={sessionSignal(status) ?? (status === 'working' ? 'working' : 'outline')}>
      {label}
    </Badge>
  )
}
