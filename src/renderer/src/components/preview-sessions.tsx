import { useState } from 'react'
import type { BuddySnapshot, PreviewSession } from '@shared/contracts'
import { AvatarPreviewTile } from './avatar-preview'
import { Button } from './ui/button'
import { cn } from '@/lib/utils'

const statuses = { working: 'Working', waiting: 'Waiting', 'needs-attention': 'Needs attention' }

export function PreviewSessions({ snapshot }: { snapshot: BuddySnapshot }) {
  const sessions = snapshot.overlay.previewSessions
  const [page, setPage] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const pages = Math.max(1, Math.ceil(sessions.length / 5))
  const currentPage = Math.min(page, pages - 1)
  const selected = sessions.find((session) => session.id === selectedId) ?? sessions[0]
  if (!selected) return null
  const avatar = (session: PreviewSession, size: string) => (
    <AvatarPreviewTile
      preview={session}
      harness={snapshot.harnesses.find((item) => item.id === session.harness)!}
      className={size}
      compactBadge={size.includes('size-9')}
    />
  )
  return (
    <div className="preview-detail">
      <div className="min-w-0">
        <div className="preview-list" aria-label="Preview sessions">
          {sessions.slice(currentPage * 5, currentPage * 5 + 5).map((session) => (
            <button
              key={session.id}
              className={cn('preview-row', selected.id === session.id && 'preview-row-selected')}
              aria-pressed={selected.id === session.id}
              onClick={() => setSelectedId(session.id)}
            >
              {avatar(session, 'size-9 shrink-0')}
              <div className="min-w-0 flex-1 text-left">
                <div className="truncate text-sm font-medium">{session.name}</div>
                <div className="truncate text-[11px] text-muted-foreground">{session.project}</div>
              </div>
              <span
                className={cn(
                  'text-[11px]',
                  session.status === 'needs-attention' ? 'text-amber-400' : 'text-muted-foreground',
                )}
              >
                {statuses[session.status]}
              </span>
            </button>
          ))}
        </div>
        {pages > 1 && (
          <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
            <Button
              variant="ghost"
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
              variant="ghost"
              size="sm"
              disabled={currentPage === pages - 1}
              onClick={() => setPage(currentPage + 1)}
            >
              Next
            </Button>
          </div>
        )}
      </div>
      <aside className="preview-inspector" aria-label="Selected preview session">
        {avatar(selected, 'size-12')}
        <h2 className="mt-4 text-base font-semibold">{selected.name}</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {snapshot.harnesses.find((item) => item.id === selected.harness)?.name} ·{' '}
          {selected.project}
        </p>
        <p className="mt-5 text-sm">{statuses[selected.status]}</p>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          Synthetic preview. No agent is connected and no command or permission is pending.
        </p>
      </aside>
    </div>
  )
}
