import { harnessFor } from '@/lib/harness'
import { useEffect, useState } from 'react'
import type { BuddySnapshot, SessionRecord } from '@shared/contracts'
import { SessionAvatar } from './session-avatar'
import { prioritizeSessions, sessionStatusLabels } from '@shared/sessions'
import { SessionRow } from './session-row'
import { Select } from './ui/select'
import { Button } from './ui/button'
import { useSessionClock } from '@/lib/use-session-clock'
import { useSessionFilters } from '@/lib/session-filters'
import { useNotice } from '@/lib/use-notice'
import { Notice } from './ui/notice'
import type { SessionAction } from '@shared/contracts'

const labels = sessionStatusLabels
const projectKey = (session: SessionRecord): string => session.cwd ?? `project:${session.project}`
const ago = (at: number, now: number): string => {
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  return seconds < 60
    ? 'Just now'
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ago`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)}h ago`
        : `${Math.floor(seconds / 86400)}d ago`
}

export function SessionList({
  snapshot,
  history = false,
}: {
  snapshot: BuddySnapshot
  history?: boolean
}) {
  const signalNow = useSessionClock(history ? snapshot.history : snapshot.sessions)
  const filters = useSessionFilters(history)
  const { harness, project, status, recent, groupBy, sort, search } = filters
  const { notice, setNotice, reportError } = useNotice()
  const [pending, setPending] = useState(false)
  const records = history
    ? [...snapshot.history].sort((a, b) => b.lastSeen - a.lastSeen)
    : prioritizeSessions(snapshot.sessions, signalNow)
  if (sort === 'recent') records.sort((a, b) => b.lastSeen - a.lastSeen || a.ordinal - b.ordinal)
  const [selection, setSelection] = useState<string | null>(
    () => records.find((item) => item.status === 'needs-attention')?.id ?? null,
  )
  const [page, setPage] = useState(0)
  const [showFilters, setShowFilters] = useState(false)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])
  const sessions = records.filter(
    (item) =>
      (harness === 'all' || item.harness === harness) &&
      (project === 'all' || projectKey(item) === project) &&
      (status === 'all' || item.status === status) &&
      (!search.trim() ||
        [item.name, item.project, item.cwd].some((value) =>
          value?.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
        )) &&
      (recent === 'all' || now - item.lastSeen < Number(recent)),
  )
  const pages = Math.max(1, Math.ceil(sessions.length / 10))
  const currentPage = Math.min(page, pages - 1)
  const visible = sessions.slice(currentPage * 10, (currentPage + 1) * 10)
  const selected = visible.find((item) => item.id === selection) ?? visible[0]
  const filtered = [harness, project, status, recent].some((filter) => filter !== 'all') || !!search
  const projects = new Map(
    records.map((record) => [
      projectKey(record),
      { label: record.project, path: record.cwd ?? record.project },
    ]),
  )
  const groups = new Map<string, { label: string; items: SessionRecord[] }>()
  for (const item of visible) {
    const key =
      groupBy === 'harness'
        ? harnessFor(snapshot, item.harness).name
        : groupBy === 'project'
          ? projectKey(item)
          : groupBy === 'status'
            ? labels[item.status]
            : history
              ? new Date(item.lastSeen).toDateString()
              : ''
    const label =
      groupBy === 'project'
        ? (item.cwd ?? item.project)
        : history && groupBy === 'none'
          ? new Date(item.lastSeen).toLocaleDateString(undefined, { dateStyle: 'medium' })
          : key
    groups.set(key, { label, items: [...(groups.get(key)?.items ?? []), item] })
  }
  const avatar = (item: SessionRecord) => (
    <SessionAvatar
      avatar={item}
      harness={harnessFor(snapshot, item.harness)}
      className="size-9 shrink-0"
      compactBadge
    />
  )
  const change =
    (setter: (value: string) => void) => (event: React.ChangeEvent<HTMLSelectElement>) => {
      setter(event.target.value)
      setPage(0)
    }
  const clearFilters = () => {
    filters.reset()
    setPage(0)
  }
  const act = async (action: SessionAction) => {
    if (!selected || pending) return
    setPending(true)
    setNotice(null)
    try {
      await window.buddy.sessionAction(selected.id, action)
      setNotice({
        text:
          action === 'reveal'
            ? 'Project revealed in Finder.'
            : action === 'copyId'
              ? 'Session ID copied.'
              : 'Project path copied.',
        error: false,
      })
    } catch (error) {
      reportError(error, 'Session action failed.')
    } finally {
      setPending(false)
    }
  }
  return (
    <div>
      <Notice message={notice} className="mb-3" />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {history && (
          <input
            type="search"
            aria-label="Search history"
            placeholder="Search name or project…"
            value={search}
            onChange={(event) => {
              filters.update({ search: event.target.value })
              setPage(0)
            }}
            className="h-8 rounded-xl border border-border bg-background px-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        )}
        <Select
          aria-label="Filter by agent"
          value={harness}
          onChange={change((harness) => filters.update({ harness }))}
        >
          <option value="all">All coding agents</option>
          {snapshot.harnesses.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter by project"
          value={project}
          onChange={change((project) => filters.update({ project }))}
        >
          <option value="all">All projects</option>
          {[...projects].map(([key, { label, path }]) => (
            <option key={key} value={key} title={path}>
              {label}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter by status"
          value={status}
          onChange={change((status) => filters.update({ status }))}
        >
          <option value="all">All statuses</option>
          {Object.entries(labels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowFilters(!showFilters)}
          aria-expanded={showFilters}
        >
          More filters
        </Button>
        {showFilters && (
          <>
            <Select
              aria-label="Filter by activity"
              value={recent}
              onChange={change((recent) => filters.update({ recent }))}
            >
              <option value="all">Any activity</option>
              <option value="300000">Last 5 minutes</option>
              <option value="3600000">Last hour</option>
              <option value="86400000">Last day</option>
            </Select>
            <Select
              aria-label="Group sessions"
              value={groupBy}
              onChange={change((groupBy) => filters.update({ groupBy }))}
            >
              <option value="none">Default order</option>
              <option value="harness">Group by agent</option>
              <option value="project">Group by project</option>
              <option value="status">Group by status</option>
            </Select>
            <Select
              aria-label="Sort sessions"
              value={sort}
              onChange={change((sort) => filters.update({ sort }))}
            >
              <option value="default">
                {history ? 'Newest history' : 'Attention, then stable order'}
              </option>
              <option value="recent">Recently active</option>
            </Select>
          </>
        )}
        {filtered && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
      </div>
      <p
        className="mb-3 text-xs text-muted-foreground"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {sessions.length} of {records.length} {history ? 'past' : 'observed'} sessions
      </p>
      <div className="session-layout">
        <div
          className="min-w-0"
          onKeyDown={(event) => {
            if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
            const row = (event.target as HTMLElement).closest<HTMLButtonElement>(
              'button.session-row',
            )
            if (!row) return
            const rows = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button.session-row'),
            ]
            const index = rows.indexOf(row)
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? rows.length - 1
                  : Math.max(
                      0,
                      Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)),
                    )
            event.preventDefault()
            rows[next]?.click()
            rows[next]?.focus()
          }}
        >
          {!sessions.length && (
            <p className="p-5 text-sm text-muted-foreground">
              {records.length
                ? 'No sessions match these filters.'
                : history
                  ? 'No session history yet.'
                  : 'No active sessions. Check your integrations to get started.'}
            </p>
          )}
          {[...groups].map(([group, { label, items }]) => (
            <div key={group}>
              {group && (
                <h3 className="mb-2 mt-3 break-all text-xs font-semibold text-muted-foreground">
                  {label}
                </h3>
              )}
              <div className="session-list">
                {items.map((item) => (
                  <SessionRow
                    key={item.id}
                    session={item}
                    harness={harnessFor(snapshot, item.harness)}
                    selected={item.id === selected?.id}
                    tabIndex={item.id === selected?.id ? 0 : -1}
                    onSelect={() => setSelection(item.id)}
                    now={signalNow}
                  />
                ))}
              </div>
            </div>
          ))}
          {pages > 1 && (
            <div className="mt-3 flex items-center justify-between text-xs">
              <Button
                variant="outline"
                size="sm"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                Previous
              </Button>
              <span>
                {currentPage + 1} / {pages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={currentPage === pages - 1}
                onClick={() => setPage(currentPage + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </div>
        {selected && (
          <aside className="session-inspector overflow-hidden" aria-label="Selected session">
            {avatar(selected)}
            <h2 className="mt-3 font-semibold">{selected.name}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {harnessFor(snapshot, selected.harness).name} · {labels[selected.status]}
            </p>
            <p className="mt-3 break-all text-xs text-muted-foreground">
              {selected.cwd ?? 'Project unavailable'}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={pending || !selected.cwd}
                onClick={() => void act('reveal')}
              >
                Reveal project
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending || !selected.cwd}
                onClick={() => void act('copyPath')}
              >
                Copy path
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => void act('copyId')}
              >
                Copy ID
              </Button>
            </div>
            <p className="mt-2 text-xs">
              {selected.presence === 'stale'
                ? 'No recent activity — current state unknown'
                : selected.presence === 'closed'
                  ? 'Session ended'
                  : `Last activity ${ago(selected.lastSeen, now)}`}
            </p>
            {selected.attention.length > 0 && (
              <div className="mt-4 rounded-lg bg-attention/10 p-3 text-xs">
                <p className="font-medium">Attention requested</p>
                {selected.attention.map((a) => (
                  <p key={a.id} className="mt-1">
                    {a.kind === 'permission' ? 'Permission requested' : 'Question asked'}
                    {a.tool ? ` · ${a.tool}` : ''}
                  </p>
                ))}
                <p className="mt-2 text-muted-foreground">Respond in your agent’s window.</p>
              </div>
            )}
            <details className="mt-5 text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                Session details & activity
              </summary>
              <dl className="mt-5 space-y-2 text-xs text-muted-foreground">
                <div>
                  <dt>Source</dt>
                  <dd>{selected.source} · client unknown</dd>
                </div>
                <div>
                  <dt>Session ID</dt>
                  <dd className="break-all">{selected.providerSessionId}</dd>
                </div>
                {selected.parentId && (
                  <div>
                    <dt>Parent</dt>
                    <dd className="break-all">{selected.parentId}</dd>
                  </div>
                )}
                <div>
                  <dt>First observed</dt>
                  <dd>{new Date(selected.firstSeen).toLocaleString()}</dd>
                </div>
              </dl>
              <h3 className="mt-5 text-xs font-medium">Observed activity</h3>
              <ol className="mt-2 space-y-2 text-xs text-muted-foreground">
                {[...selected.activity]
                  .reverse()
                  .slice(0, 8)
                  .map((a, i) => (
                    <li key={`${a.at}-${i}`}>
                      {a.event}
                      {a.tool ? ` · ${a.tool}` : ''}
                      <span className="block text-[10px]">
                        {new Date(a.at).toLocaleTimeString()}
                      </span>
                    </li>
                  ))}
              </ol>
            </details>
          </aside>
        )}
      </div>
    </div>
  )
}
