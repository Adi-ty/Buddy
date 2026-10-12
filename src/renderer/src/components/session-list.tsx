import { harnessFor } from '@/lib/harness'
import { useEffect, useState, useRef } from 'react'
import type { BuddySnapshot, SessionRecord } from '@shared/contracts'
import { SessionAvatar } from './session-avatar'
import { sessionStatusLabels } from '@shared/sessions'
import { SessionRow } from './session-row'
import { Select } from './ui/select'
import { Button } from './ui/button'
import { useSessionClock } from '@/lib/use-session-clock'
import { useSessionFilters } from '@/lib/session-filters'
import { useNotice } from '@/lib/use-notice'
import { Notice } from './ui/notice'
import type { SessionAction } from '@shared/contracts'
import { familyInputSession, sessionFamilies, relativeTime } from '@shared/session-families'
import { SubagentList } from './subagent-list'
import { sessionPage, nextSessionRow } from '@/lib/session-list-view'
import { SessionRequests } from './session-requests'

const labels = sessionStatusLabels
const projectKey = (session: SessionRecord): string => session.cwd ?? `project:${session.project}`

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
  const context = [...snapshot.sessions, ...snapshot.history]
  const families = sessionFamilies(
    history ? snapshot.history : snapshot.sessions,
    context,
    signalNow,
  )
  if (history || sort === 'recent')
    families.sort(
      (a, b) => b.summary.lastSeen - a.summary.lastSeen || a.root.ordinal - b.root.ordinal,
    )
  const familyById = new Map(families.map((family) => [family.root.id, family]))
  const records = families.map((family) => family.summary)
  const listRef = useRef<HTMLDivElement>(null)
  const pendingFocus = useRef<string | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [selection, setSelection] = useState<string | null>(() => {
    const family = families.find((item) => item.summary.status === 'needs-attention')
    return family ? familyInputSession(family, snapshot.requests).id : null
  })
  const [dismissed, setDismissed] = useState(false)
  const [page, setPage] = useState(0)
  const [showFilters, setShowFilters] = useState(false)
  useEffect(() => setPage(0), [harness, project, status, recent, search, groupBy, sort])
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])
  const matches = (item: SessionRecord) =>
    (harness === 'all' || item.harness === harness) &&
    (project === 'all' || projectKey(item) === project) &&
    (!search.trim() ||
      [item.name, item.project, item.cwd].some((value) =>
        value?.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
      )) &&
    (recent === 'all' || now - item.lastSeen < Number(recent))
  const matchingFamilies = families.filter((family) =>
    [family.summary, ...family.members].some(matches),
  )
  const matched = matchingFamilies
    .filter((family) => status === 'all' || family.summary.status === status)
    .map((family) => family.summary)
  const matchedSubagents = matchingFamilies
    .filter((family) => status === 'all' || family.summary.status === status)
    .flatMap((family) => family.members)
    .filter((item) => item.parentId).length
  const {
    ordered: sessions,
    pages,
    page: currentPage,
    visible,
    groups,
  } = sessionPage(
    matched,
    (item) => {
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
      return { key, label }
    },
    page,
  )
  const selectedFamily = dismissed
    ? undefined
    : (families.find(
        (family) =>
          sessions.some((row) => row.id === family.root.id) &&
          [family.root, ...family.descendants].some((item) => item.id === selection),
      ) ?? families.find((family) => family.root.id === visible[0]?.id))
  const selected = selectedFamily
    ? ([selectedFamily.root, ...selectedFamily.descendants].find((item) => item.id === selection) ??
      (history ? selectedFamily.root : familyInputSession(selectedFamily, snapshot.requests)))
    : undefined
  useEffect(() => {
    if (!pendingFocus.current) return
    const row = [
      ...(listRef.current?.querySelectorAll<HTMLButtonElement>('button.session-row') ?? []),
    ].find((item) => item.dataset.sessionId === pendingFocus.current)
    if (row) {
      pendingFocus.current = null
      row.focus()
    }
  }, [currentPage, focusId])
  const filtered = [harness, project, status, recent].some((filter) => filter !== 'all') || !!search
  const projects = new Map(
    (history ? snapshot.history : snapshot.sessions).map((record) => [
      projectKey(record),
      { label: record.project, path: record.cwd ?? record.project },
    ]),
  )
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
  const select = (id: string) => {
    setDismissed(false)
    setSelection(id)
  }
  return (
    <div
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        const details = (event.target as HTMLElement).closest(
          'details[open]',
        ) as HTMLDetailsElement | null
        if (details) {
          details.open = false
          details.querySelector('summary')?.focus()
        } else {
          const rows = [
            ...(listRef.current?.querySelectorAll<HTMLButtonElement>('button.session-row') ?? []),
          ]
          const target =
            rows.find((row) => row.dataset.sessionId === selectedFamily?.root.id) ??
            rows.find((row) => row.tabIndex === 0)
          setDismissed(true)
          setShowFilters(false)
          if (target) {
            setFocusId(target.dataset.sessionId ?? null)
            target.focus()
          }
        }
        event.stopPropagation()
      }}
    >
      {!history && (
        <div className="session-status-filters" role="group" aria-label="Quick status filters">
          {[
            ['all', 'All sessions'],
            ['working', 'Working'],
            ['needs-attention', 'Needs attention'],
            ['completed', 'Finished'],
            ['error', 'Errors'],
          ].map(([value, label]) => (
            <button
              key={value}
              className="session-status-filter"
              data-status={value}
              aria-pressed={status === value}
              onClick={() => filters.update({ status: value })}
            >
              <span>{label}</span>
              <strong>
                {
                  matchingFamilies.filter(
                    (family) => value === 'all' || family.summary.status === value,
                  ).length
                }
              </strong>
            </button>
          ))}
        </div>
      )}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          type="search"
          aria-label={history ? 'Search history' : 'Search sessions'}
          placeholder="Search name or project…"
          value={search}
          onChange={(event) => {
            filters.update({ search: event.target.value })
            setPage(0)
          }}
          className="h-8 rounded-xl border border-border bg-background px-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
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
        {matchedSubagents > 0 && ` · ${matchedSubagents} subagents`}
      </p>
      <div className="session-layout">
        <div
          className="min-w-0"
          ref={listRef}
          onKeyDown={(event) => {
            if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
            const row = (event.target as HTMLElement).closest<HTMLButtonElement>(
              'button.session-row',
            )
            if (!row) return
            const isChild = !sessions.some((item) => item.id === row.dataset.sessionId)
            const visibleRows = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button.session-row'),
            ]
            const position = visibleRows.indexOf(row)
            const local =
              event.key === 'ArrowDown'
                ? visibleRows[position + 1]
                : event.key === 'ArrowUp'
                  ? visibleRows[position - 1]
                  : null
            if (
              event.key === 'End' &&
              selectedFamily &&
              sessions.at(-1)?.id === selectedFamily?.root.id &&
              selectedFamily.descendants.length
            ) {
              const last = visibleRows.at(-1)
              if (last) {
                event.preventDefault()
                setFocusId(last.dataset.sessionId ?? null)
                last.focus()
                return
              }
            }
            if (local) {
              event.preventDefault()
              setFocusId(local.dataset.sessionId ?? null)
              local.focus()
              return
            }
            const rootId = isChild ? selectedFamily?.root.id : row.dataset.sessionId
            const next = nextSessionRow(sessions, rootId ?? '', event.key)
            if (!next) return
            event.preventDefault()
            pendingFocus.current = next.id
            setFocusId(next.id)
            setPage(Math.floor(sessions.findIndex((item) => item.id === next.id) / 10))
            // Focus movement does not activate the row. Enter/Space selects it.
            const button = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button.session-row'),
            ].find((item) => item.dataset.sessionId === next.id)
            if (button) {
              pendingFocus.current = null
              button.focus()
            }
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
                {items.map((item) => {
                  const family = familyById.get(item.id)!
                  return (
                    <SessionRow
                      key={item.id}
                      session={family.root}
                      summary={item}
                      subagentCount={family.descendants.length}
                      subagentFailureCount={
                        family.descendants.filter((item) => item.status === 'error').length
                      }
                      harness={harnessFor(snapshot, item.harness)}
                      selected={item.id === selectedFamily?.root.id}
                      tabIndex={
                        item.id ===
                        (visible.some((row) => row.id === focusId) ||
                        (visible.some((row) => row.id === selectedFamily?.root.id) &&
                          selectedFamily?.descendants.some((child) => child.id === focusId))
                          ? focusId
                          : visible.some((row) => row.id === selectedFamily?.root.id)
                            ? selectedFamily?.root.id
                            : visible[0]?.id)
                          ? 0
                          : -1
                      }
                      onFocus={() => setFocusId(item.id)}
                      onSelect={() =>
                        select(
                          history
                            ? item.id
                            : familyInputSession(familyById.get(item.id)!, snapshot.requests).id,
                        )
                      }
                      now={signalNow}
                    >
                      {item.id === selectedFamily?.root.id && (
                        <SubagentList
                          root={selectedFamily.root}
                          sessions={selectedFamily.descendants}
                          snapshot={snapshot}
                          selectedId={selection}
                          onSelect={select}
                          roving
                          focusId={focusId}
                          onFocus={setFocusId}
                          now={signalNow}
                        />
                      )}
                    </SessionRow>
                  )
                })}
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
            <SessionRequests session={selected} snapshot={snapshot} />
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
            <Notice message={notice} className="mt-3" />
            <p className="mt-2 text-xs">
              {selected.presence === 'stale'
                ? 'No recent activity — current state unknown'
                : selected.presence === 'closed'
                  ? 'Session ended'
                  : `Last activity ${relativeTime(selected.lastSeen, now)}`}
            </p>
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
