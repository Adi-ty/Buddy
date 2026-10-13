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
import { compactNotchBounds, matchesBounds } from '@shared/overlay-layout'

export function OverlayView() {
  const { snapshot, failed } = useBuddySnapshot()
  useEffect(() => {
    document.documentElement.classList.add('overlay-window')
    return () => document.documentElement.classList.remove('overlay-window')
  }, [])
  return snapshot ? (
    <OverlaySessions snapshot={snapshot} />
  ) : failed ? (
    <div
      className="overlay-surface justify-center px-3 text-[10px]"
      role="alert"
      title="The notch couldn’t reconnect. Open Buddy from its menu to retry."
    >
      Offline
    </div>
  ) : null
}

export function OverlaySessions({ snapshot }: { snapshot: BuddySnapshot }) {
  const now = useSessionClock(snapshot.sessions, snapshot.overlay.expanded)
  const { notice, setNotice } = useNotice()
  const [selection, setSelection] = useState<{
    familyId: string
    sessionId: string | null
  } | null>(null)
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const details = (event.target as HTMLElement).closest(
        'details[open]',
      ) as HTMLDetailsElement | null
      if (details) {
        details.open = false
        details.querySelector('summary')?.focus()
      } else if (selection) setSelection(null)
      else {
        void window.buddy.setOverlayExpanded(false).catch(() =>
          setNotice({
            error: true,
            text: 'Couldn’t collapse the notch. Try its collapse button.',
          }),
        )
      }
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [selection, setNotice])
  const families = sessionFamilies(
    notchRecords(
      snapshot.sessions,
      now,
      [...snapshot.sessions, ...snapshot.history],
      snapshot.overlay.completionHoldIds,
    ),
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
  const display = snapshot.overlay.displays?.find((item) => item.id === snapshot.overlay.anchorId)
  const proposedWings = !expanded && display && compactNotchBounds(display)
  // Renderer HMR can run ahead of the main process, and native moves can be
  // constrained. Never draw a camera gap using intended placement alone.
  const wings =
    proposedWings && matchesBounds(proposedWings, snapshot.overlay.actualBounds)
      ? proposedWings
      : null
  const label = `${sessions.length} sessions · ${summary}. Click to open sessions.`
  const avatars = (
    <span className="flex items-center -space-x-3" aria-hidden="true">
      {sessions.slice(0, 2).map((session) => (
        <span key={session.id} className="relative rounded-lg bg-background ring-1 ring-background">
          <SessionAvatar
            avatar={session}
            harness={harnessFor(snapshot, session.harness)}
            className={wings ? 'size-6' : 'size-7'}
            notchBadge
          />
        </span>
      ))}
    </span>
  )
  const shortStatus = attention.length
    ? `${attention.length} waiting`
    : errors
      ? `${errors} error`
      : working
        ? `${working} busy`
        : finished
          ? 'Done'
          : 'Quiet'
  const compactStatus = (
    <span className={cn('min-w-0 text-center', signalColor)}>
      <span className="block text-[11px] font-medium leading-4">
        {sessions.length > 2 ? `+${sessions.length - 2}` : `${sessions.length} live`}
      </span>
      <span className="block truncate text-[9px] leading-3">{shortStatus}</span>
    </span>
  )
  return (
    <SignalBoundary
      signal={signal}
      revision={signalRevision(sessions, signal, now)}
      className={cn('overlay-surface', wings && 'overlay-wings')}
      style={
        wings && display?.camera
          ? {
              gridTemplateColumns: `${display.camera.x - wings.x}px ${display.camera.width}px minmax(0, 1fr)`,
            }
          : undefined
      }
    >
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {sessions.length} sessions · {summary}
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
                    subagentFailureCount={
                      family.descendants.filter((item) => item.status === 'error').length
                    }
                    compact
                    expandable
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
      ) : wings ? (
        <>
          <button
            className="overlay-compact overlay-wing overlay-wing-left"
            onClick={() => invoke(window.buddy.setOverlayExpanded(true))}
            aria-label={label}
            title={label}
            aria-expanded={false}
          >
            {avatars}
          </button>
          <button
            className="overlay-compact overlay-wing overlay-wing-right"
            onClick={() => invoke(window.buddy.setOverlayExpanded(true))}
            aria-label={
              attention.length ? `Review ${attention.length} sessions needing attention` : label
            }
            title={label}
            aria-expanded={false}
          >
            {compactStatus}
          </button>
        </>
      ) : (
        <button
          className="overlay-compact"
          onClick={() => invoke(window.buddy.setOverlayExpanded(true))}
          aria-label={label}
          title={label}
          aria-expanded={false}
        >
          {avatars}
          {sessions.length > 2 && (
            <span className="text-xs text-muted-foreground">+{sessions.length - 2}</span>
          )}
          <span className={cn('ml-auto text-xs', signalColor)}>{summary}</span>
          <ChevronDown size={13} className="shrink-0 text-muted-foreground" />
        </button>
      )}
    </SignalBoundary>
  )
}
