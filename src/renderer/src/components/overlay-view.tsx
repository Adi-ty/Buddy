import { useEffect, useState } from 'react'
import { ChevronDown, X } from 'lucide-react'
import { useBuddySnapshot } from '@/lib/use-buddy-snapshot'
import { AvatarPreviewTile } from './avatar-preview'
import { PreviewSessions } from './preview-sessions'

export function OverlayView() {
  const { snapshot, failed } = useBuddySnapshot()
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    document.documentElement.classList.add('overlay-window')
    return () => document.documentElement.classList.remove('overlay-window')
  }, [])
  if (!snapshot || failed) return null
  const { overlay } = snapshot
  const attention = overlay.previewSessions.find((session) => session.status === 'needs-attention')
  const invoke = (action: Promise<void>) => {
    void action.catch(() => setError('Open the dashboard to retry.'))
  }
  return (
    <div className={`overlay-surface ${attention ? 'overlay-attention' : ''}`}>
      {overlay.expanded ? (
        <>
          <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
            <div className="text-sm font-semibold">
              Preview · {overlay.previewSessions.length} sessions
            </div>
            <button
              className="overlay-icon-button"
              aria-label="Collapse preview"
              onClick={() => invoke(window.buddy.setOverlayExpanded(false))}
            >
              <X size={16} />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {attention && (
              <div className="mb-3 rounded-lg bg-amber-400/10 px-3 py-2 text-xs text-amber-400">
                {attention.name} needs attention · preview only
              </div>
            )}
            <PreviewSessions snapshot={snapshot} />
          </div>
          <footer className="flex h-10 shrink-0 items-center justify-between border-t border-border px-4 text-[11px] text-muted-foreground">
            <span>{error ?? 'Preview · not live agent activity'}</span>
            <button
              className="font-medium text-foreground"
              onClick={() => invoke(window.buddy.openDashboard())}
            >
              Open dashboard
            </button>
          </footer>
        </>
      ) : (
        <button
          className="overlay-compact"
          onClick={() => invoke(window.buddy.setOverlayExpanded(true))}
          aria-label={`Expand preview, ${overlay.previewSessions.length} sessions${attention ? ', needs attention' : ''}`}
        >
          <div className="flex items-center -space-x-1.5">
            {overlay.previewSessions.slice(0, 5).map((session) => (
              <AvatarPreviewTile
                key={session.id}
                preview={session}
                harness={snapshot.harnesses.find((item) => item.id === session.harness)!}
                className="size-8 ring-2 ring-[#171818]"
                compactBadge
              />
            ))}
            {overlay.previewSessions.length > 5 && (
              <span className="relative ml-2 text-xs text-muted-foreground">
                +{overlay.previewSessions.length - 5}
              </span>
            )}
          </div>
          <span
            className={`ml-auto text-right text-[11px] ${attention ? 'text-amber-400' : 'text-muted-foreground'}`}
          >
            <span className="block font-medium">
              {attention ? 'Needs you' : `${overlay.previewSessions.length} sessions`}
            </span>
            <span className="block text-[10px] text-muted-foreground">Preview</span>
          </span>
          <ChevronDown size={13} className="text-muted-foreground" />
        </button>
      )}
    </div>
  )
}
