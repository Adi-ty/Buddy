import { harnessFor } from '@/lib/harness'
import { useEffect, useState } from 'react'
import { ArrowUpRight, ChevronDown, ChevronUp } from 'lucide-react'
import {
  notchRecords,
  notchSignal,
  sessionNotification,
  signalRevision,
  sessionLastTool,
} from '@shared/sessions'
import { useBuddySnapshot } from '@/lib/use-buddy-snapshot'
import { useSessionClock } from '@/lib/use-session-clock'
import { SessionAvatar } from './session-avatar'
import { SessionRow } from './session-row'
import { SignalBoundary } from './ui/signal-boundary'
import { Button } from './ui/button'
import { cn } from '@/lib/utils'
import { useNotice } from '@/lib/use-notice'
import { Notice } from './ui/notice'
import { familyInputSession, sessionFamilies } from '@shared/session-families'
import { SubagentList } from './subagent-list'
import type { BuddySnapshot } from '@shared/contracts'
import { SessionRequests } from './session-requests'

export function OverlayView() {
  const { snapshot, failed } = useBuddySnapshot()
  useEffect(() => {
    document.documentElement.classList.add('overlay-window')
    return () => document.documentElement.classList.remove('overlay-window')
  }, [])
  return snapshot && !failed ? <OverlaySessions snapshot={snapshot} /> : null
}

export function OverlaySessions({ snapshot }: { snapshot: BuddySnapshot }) {
  const now = useSessionClock(snapshot.sessions, snapshot.overlay.expanded)
  const { notice, setNotice } = useNotice()
  const [selection, setSelection] = useState<{
    familyId: string
    sessionId: string | null
  } | null>(null)
  const families = sessionFamilies(
    notchRecords(snapshot.sessions, now),
    [...snapshot.sessions, ...snapshot.history],
    now,
  )
  const sessions = families.map((family) => family.summary)
  const subagents = snapshot.sessions.filter((session) => session.parentId).length
  if (!sessions.length) return null
  const attention = sessions.filter((session) => session.status === 'needs-attention')
  const signal = notchSignal(sessions, now)
  const finished = sessions.filter(
    (session) => sessionNotification(session, now) === 'success',
  ).length
  const errors = sessions.filter((session) => session.status === 'error').length
  const working = sessions.filter((session) => session.status === 'working').length
  const invoke = (action: Promise<void>) => {
    setNotice(null)
    void action.catch(() =>
      setNotice({ error: true, text: 'Couldn’t open. Try again from Buddy’s menu.' }),
    )
  }
  const expanded = snapshot.overlay.expanded
  const summary = attention.length
    ? `${attention.length} waiting for you`
    : errors
      ? `${errors} ${errors === 1 ? 'error' : 'errors'}`
      : finished
        ? `${finished} finished${working ? ` · ${working} working` : ''}`
        : working
          ? `${working} working`
          : 'All quiet'
  const signalColor =
    signal === 'attention'
      ? 'text-attention'
      : signal === 'error'
        ? 'text-error'
        : signal === 'success'
          ? 'text-success'
          : 'text-muted-foreground'
  return (
    <SignalBoundary
      signal={signal}
      revision={signalRevision(sessions, signal, now)}
      className="overlay-surface"
    >
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {summary}
      </span>
      {expanded ? (
        <>
          <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
            <div>
              <h1 className="text-sm font-semibold">
                {sessions.length} {sessions.length === 1 ? 'session' : 'sessions'}
                {subagents > 0 && ` · ${subagents} ${subagents === 1 ? 'subagent' : 'subagents'}`}
              </h1>
              <p className={cn('mt-0.5 text-[11px]', signalColor)}>{summary}</p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Collapse sessions"
              onClick={() => invoke(window.buddy.setOverlayExpanded(false))}
            >
              <ChevronUp />
            </Button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <div className="space-y-2">
              {families.map((family) => {
                const session = family.root
                const selected =
                  selection?.familyId === session.id
                    ? ([session, ...family.descendants].find(
                        (item) => item.id === selection.sessionId,
                      ) ?? familyInputSession(family, snapshot.requests))
                    : undefined
                return (
                  <SessionRow
                    key={session.id}
                    session={session}
                    harness={harnessFor(snapshot, session.harness)}
                    selected={Boolean(selected)}
                    summary={family.summary}
                    subagentCount={family.descendants.length}
                    compact
                    now={now}
                    onSelect={() =>
                      setSelection(selected ? null : { familyId: session.id, sessionId: null })
                    }
                  >
                    {selected && (
                      <>
                        {selected.id !== session.id && (
                          <p className="mt-2 truncate font-medium" title={selected.name}>
                            {selected.name}
                          </p>
                        )}
                        <SessionRequests session={selected} snapshot={snapshot} overlay />
                        <p className="mt-3 break-all text-muted-foreground">
                          {selected.cwd ?? selected.project}
                        </p>
                        <p className="mt-1.5">
                          {sessionLastTool(selected)
                            ? `Last tool: ${sessionLastTool(selected)}`
                            : 'No tool activity yet'}
                        </p>
                        <SubagentList
                          root={session}
                          sessions={family.descendants}
                          snapshot={snapshot}
                          selectedId={selected.id}
                          onSelect={(id) => setSelection({ familyId: session.id, sessionId: id })}
                          now={now}
                          collapsible
                        />
                      </>
                    )}
                  </SessionRow>
                )
              })}
            </div>
          </div>
          <footer className="flex h-11 shrink-0 items-center justify-between gap-2 border-t border-border px-3">
            {notice ? (
              <Notice message={notice} className="border-0 bg-transparent p-0 text-[11px]" />
            ) : (
              <span className="text-[11px] text-muted-foreground">
                {snapshot.overlay.shortcutAvailable ? '⌘⇧Space for details' : 'Live agent activity'}
              </span>
            )}
            <Button variant="ghost" size="sm" onClick={() => invoke(window.buddy.openDashboard())}>
              Dashboard <ArrowUpRight />
            </Button>
          </footer>
        </>
      ) : (
        <button
          className="overlay-compact"
          onClick={() => invoke(window.buddy.setOverlayExpanded(true))}
          aria-label={`Expand ${sessions.length} sessions${attention.length ? `, ${attention.length} need attention` : ''}`}
          aria-expanded={false}
        >
          <span className="flex items-center -space-x-1.5">
            {sessions.slice(0, 5).map((session) => (
              <span
                key={session.id}
                className="relative rounded-lg bg-background ring-2 ring-background"
                title={session.name}
                aria-label={`${session.name} · ${session.project}`}
              >
                <SessionAvatar
                  avatar={session}
                  harness={harnessFor(snapshot, session.harness)}
                  className="size-8"
                  compactBadge
                />
                {sessionNotification(session, now) && (
                  <span
                    className={`avatar-signal avatar-signal-${sessionNotification(session, now)}`}
                    aria-hidden="true"
                  >
                    {session.status === 'completed' ? '✓' : '!'}
                  </span>
                )}
              </span>
            ))}
            {sessions.length > 5 && (
              <span className="pl-3 text-xs text-muted-foreground">+{sessions.length - 5}</span>
            )}
          </span>
          <span className="ml-auto min-w-0 text-right text-[11px]">
            <span
              className={cn('block truncate font-medium', signalColor)}
              title={families[0]!.root.name}
            >
              {families[0]!.root.name}
            </span>
            <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
              {harnessFor(snapshot, families[0]!.root.harness).name} ·{' '}
              {sessions.length > 1 ? `${sessions.length} sessions · ` : ''}
              {summary}
            </span>
          </span>
          <ChevronDown size={13} className="shrink-0 text-muted-foreground" />
        </button>
      )}
    </SignalBoundary>
  )
}
