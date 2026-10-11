import type { HarnessCatalogEntry, SessionRecord } from '@shared/contracts'
import type { ReactNode } from 'react'
import { sessionAttentionLabel, sessionNotification, signalRevision } from '@shared/sessions'
import { SignalBoundary } from './ui/signal-boundary'
import { SessionStatus } from './session-status'
import { SessionAvatar } from './session-avatar'
import { cn } from '@/lib/utils'

export function SessionRow({
  session,
  harness,
  selected,
  compact = false,
  onSelect,
  children,
  now = Date.now(),
  tabIndex,
}: {
  session: SessionRecord
  harness: HarnessCatalogEntry
  selected?: boolean
  compact?: boolean
  onSelect: () => void
  children?: ReactNode
  now?: number
  tabIndex?: number
}) {
  const signal = sessionNotification(session, now)
  const detail = sessionAttentionLabel(session)
  const description = detail
    ? `${session.project} · ${detail}`
    : session.status === 'completed'
      ? `${session.project} · Turn finished`
      : session.status === 'error'
        ? `${session.project} · Check your agent`
        : session.project
  return (
    <SignalBoundary
      signal={signal}
      revision={signalRevision([session], signal, now)}
      className={cn('session-card', selected && 'session-card-selected')}
    >
      <button
        tabIndex={tabIndex}
        className="session-row"
        aria-pressed={selected}
        aria-expanded={compact ? Boolean(children) : undefined}
        onClick={onSelect}
      >
        <SessionAvatar avatar={session} harness={harness} className="size-9" compactBadge />
        <span className="min-w-0 flex-1 text-left">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium" title={session.name}>
              {session.name}
            </span>
            {session.parentId && (
              <span className="text-[10px] text-muted-foreground">Subagent</span>
            )}
          </span>
          <span
            className={cn(
              'mt-1 block truncate text-[11px]',
              signal === 'attention'
                ? 'text-attention'
                : signal === 'error'
                  ? 'text-error'
                  : signal === 'success'
                    ? 'text-success'
                    : 'text-muted-foreground',
            )}
          >
            {description}
          </span>
        </span>
        <SessionStatus status={session.status} compact={compact} />
      </button>
      {children && <div className="session-row-details">{children}</div>}
    </SignalBoundary>
  )
}
