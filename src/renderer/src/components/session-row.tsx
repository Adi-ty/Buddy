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
  summary = session,
  subagentCount = 0,
  subagentFailureCount = 0,
  onFocus,
}: {
  session: SessionRecord
  harness: HarnessCatalogEntry
  selected?: boolean
  compact?: boolean
  onSelect: () => void
  children?: ReactNode
  now?: number
  tabIndex?: number
  summary?: SessionRecord
  subagentCount?: number
  subagentFailureCount?: number
  onFocus?: () => void
}) {
  const signal = sessionNotification(summary, now)
  const detail = sessionAttentionLabel(summary)
  const description =
    detail ??
    (summary.status === 'completed'
      ? 'Turn finished'
      : summary.status === 'error'
        ? 'Check your agent'
        : null)
  return (
    <SignalBoundary
      signal={signal}
      revision={signalRevision([summary], signal, now)}
      className={cn('session-card', selected && 'session-card-selected')}
    >
      <button
        tabIndex={tabIndex}
        className="session-row"
        aria-pressed={selected}
        aria-expanded={compact ? Boolean(children) : undefined}
        onClick={onSelect}
        onFocus={onFocus}
        data-session-id={session.id}
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
            {subagentCount > 0 && (
              <span className="shrink-0 text-[10px] text-muted-foreground">
                +{subagentCount} {subagentCount === 1 ? 'subagent' : 'subagents'}
                {subagentFailureCount > 0 && ` · ${subagentFailureCount} failed`}
              </span>
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
            {harness.name}
            {description ? ` · ${description}` : ''}
            {summary.status !== session.status && ' · Includes subagent activity'}
          </span>
        </span>
        <SessionStatus status={summary.status} compact={compact} />
      </button>
      {children && <div className="session-row-details">{children}</div>}
    </SignalBoundary>
  )
}
