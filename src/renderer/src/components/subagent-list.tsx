import type { BuddySnapshot, SessionRecord } from '@shared/contracts'
import { sessionStatusLabels } from '@shared/sessions'
import { harnessFor } from '@/lib/harness'
import { SessionRow } from './session-row'
import { Button } from './ui/button'

export function SubagentList({
  root,
  sessions,
  snapshot,
  selectedId,
  onSelect,
  now,
  collapsible = false,
}: {
  root: SessionRecord
  sessions: readonly SessionRecord[]
  snapshot: BuddySnapshot
  selectedId?: string | null
  onSelect: (id: string) => void
  now: number
  collapsible?: boolean
}) {
  if (!sessions.length) return null
  const active = sessions.filter((item) => item.presence === 'observed').length
  const content = (
    <>
      <p className="text-[11px] text-muted-foreground">
        Parent: {sessionStatusLabels[root.status]} · {sessions.length}{' '}
        {sessions.length === 1 ? 'subagent' : 'subagents'} · {active} observed
      </p>
      {selectedId && selectedId !== root.id && (
        <Button variant="ghost" size="sm" onClick={() => onSelect(root.id)}>
          View parent session
        </Button>
      )}
      {sessions.map((child) => (
        <div key={child.id} className="ml-2 border-l border-border pl-2">
          <SessionRow
            session={child}
            harness={harnessFor(snapshot, child.harness)}
            compact
            selected={selectedId === child.id}
            now={now}
            onSelect={() => onSelect(child.id)}
          />
          {child.presence !== 'observed' && (
            <p className="mt-1 text-[10px] text-muted-foreground">
              {child.presence === 'closed'
                ? 'Session ended'
                : 'No recent activity — current state unknown'}
            </p>
          )}
          {child.parentId !== root.id && (
            <p className="mt-1 truncate text-[10px] text-muted-foreground">
              Parent:{' '}
              {[...snapshot.sessions, ...snapshot.history].find(
                (item) => item.id === child.parentId,
              )?.name ?? 'Unavailable'}
            </p>
          )}
        </div>
      ))}
    </>
  )
  return (
    <section aria-label={`Subagents of ${root.name}`} className="space-y-2">
      {collapsible ? (
        <details className="mt-4">
          <summary className="cursor-pointer text-[11px] text-muted-foreground">
            {sessions.length} {sessions.length === 1 ? 'subagent' : 'subagents'}
          </summary>
          <div className="mt-2 space-y-2">{content}</div>
        </details>
      ) : (
        content
      )}
    </section>
  )
}
