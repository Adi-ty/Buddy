import { useEffect, useRef, useState } from 'react'
import { Monitor, RefreshCw } from 'lucide-react'
import { PREVIEW_MODES, type BuddySnapshot, type OverlayPreviewOptions } from '@shared/contracts'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { PreviewSessions } from './preview-sessions'

export function OverlayPreviewPage({ snapshot }: { snapshot: BuddySnapshot }) {
  const { overlay } = snapshot
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [scheduled, setScheduled] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  const labels = {
    idle: 'Hidden',
    running: '3 sessions',
    overflow: '8 sessions',
    attention: 'Needs attention',
  }
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch {
      setError('Buddy couldn’t update the overlay. Try again.')
    } finally {
      setBusy(false)
    }
  }
  const configure = (changes: Partial<OverlayPreviewOptions>) => {
    void run(() =>
      window.buddy.setOverlayPreview({
        mode: overlay.mode,
        displayId: overlay.displayId,
        clickThrough: overlay.clickThrough,
        ...changes,
      }),
    )
  }
  const anchor = overlay.displays.find((display) => display.id === overlay.anchorId)
  return (
    <>
      <header className="mb-7 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[27px] font-semibold tracking-tight">Overlay preview</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Test Buddy on your displays before connecting an agent.
          </p>
        </div>
        <Badge variant="outline">
          {snapshot.runtime.packaged ? 'Prototype mode' : 'Development only'}
        </Badge>
      </header>
      <section className="rounded-2xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold">Preview state</h2>
        <div className="mt-4 flex flex-wrap gap-2" aria-label="Overlay preview state">
          {PREVIEW_MODES.map((mode) => (
            <Button
              key={mode}
              variant={overlay.mode === mode ? 'default' : 'outline'}
              disabled={busy}
              aria-pressed={overlay.mode === mode}
              onClick={() => configure({ mode })}
            >
              {labels[mode]}
            </Button>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || scheduled}
            onClick={() => {
              setScheduled(true)
              timer.current = setTimeout(() => {
                timer.current = null
                setScheduled(false)
                configure({ mode: 'attention' })
              }, 5000)
            }}
          >
            {scheduled ? 'Attention preview scheduled…' : 'Show attention in 5 seconds'}
          </Button>
          <span className="text-[11px] text-muted-foreground">
            Switch to an editor and keep typing to test focus.
          </span>
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-t border-border pt-4">
          <label className="text-sm">
            Display
            <select
              className="ml-3 max-w-[260px] rounded-lg border border-border bg-background px-3 py-2 text-xs"
              aria-label="Overlay display"
              disabled={busy || overlay.geometry !== 'ready'}
              value={overlay.displayId ?? 'auto'}
              onChange={(event) =>
                configure({
                  displayId: event.target.value === 'auto' ? null : Number(event.target.value),
                })
              }
            >
              <option value="auto">Automatic · prefer built-in display</option>
              {overlay.displays.map((display) => (
                <option key={display.id} value={display.id}>
                  {display.name}
                  {display.camera ? ' · notch' : ' · shelf'}
                </option>
              ))}
              {overlay.displayId !== null &&
                !overlay.displays.some((display) => display.id === overlay.displayId) && (
                  <option value={overlay.displayId}>Selected display unavailable</option>
                )}
            </select>
          </label>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || overlay.geometry === 'loading'}
            onClick={() => {
              void run(() => window.buddy.refreshDisplays())
            }}
          >
            <RefreshCw size={14} /> Refresh displays
          </Button>
        </div>
        <label className="mt-4 flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-1 accent-[#f2d3b1]"
            checked={overlay.clickThrough}
            disabled={busy}
            onChange={(event) => configure({ clickThrough: event.target.checked })}
          />
          <span>
            Pass clicks through the entire overlay
            <span className="mt-1 block text-xs leading-5 text-muted-foreground">
              The preview stays visible; clicks, drags, and scrolling go to the app below it.
            </span>
          </span>
        </label>
        {(error || overlay.message) && (
          <p className="mt-4 text-sm" role="status">
            {error ?? overlay.message}
          </p>
        )}
      </section>
      <section className="mt-4 rounded-2xl border border-border p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Monitor size={16} /> Placement
        </h2>
        <dl className="mt-4 grid grid-cols-[130px_1fr] gap-3 text-xs">
          <dt className="text-muted-foreground">Native geometry</dt>
          <dd>{overlay.geometry}</dd>
          <dt className="text-muted-foreground">Overlay</dt>
          <dd>{overlay.visible ? 'Visible · does not take keyboard focus' : 'Hidden'}</dd>
          <dt className="text-muted-foreground">Anchor</dt>
          <dd>
            {anchor
              ? `${anchor.name} · ${anchor.camera ? 'below the notch' : 'below the menu bar'}`
              : 'None'}
          </dd>
          <dt className="text-muted-foreground">Window bounds</dt>
          <dd className="font-mono">
            {overlay.actualBounds
              ? `x ${overlay.actualBounds.x}, y ${overlay.actualBounds.y}, ${overlay.actualBounds.width} × ${overlay.actualBounds.height}`
              : '—'}
          </dd>
          <dt className="text-muted-foreground">Keyboard access</dt>
          <dd>
            {overlay.shortcutAvailable
              ? '⌘⇧Space opens the dashboard'
              : 'Global shortcut unavailable; use Buddy’s View menu'}
          </dd>
        </dl>
        <p className="mt-4 text-xs leading-5 text-muted-foreground">
          The camera housing and menu bar stay clear. Click the compact preview for detail; it
          collapses after you move away.
        </p>
        {overlay.displays.length > 0 && (
          <details className="mt-4 text-xs">
            <summary className="cursor-pointer text-muted-foreground">Display geometry</summary>
            <div className="mt-3 space-y-3">
              {overlay.displays.map((display) => (
                <div key={display.id} className="rounded-lg border border-border p-3">
                  <div className="font-medium">
                    {display.name} · ID {display.id}
                  </div>
                  <div className="mt-2 space-y-1 font-mono text-[11px] text-muted-foreground">
                    <p>
                      Bounds: {display.bounds.x}, {display.bounds.y} · {display.bounds.width} ×{' '}
                      {display.bounds.height} DIP
                    </p>
                    <p>
                      Scale: {display.scaleFactor} · safe top: {display.safeTop} DIP
                    </p>
                    <p>
                      Camera:{' '}
                      {display.camera
                        ? `${display.camera.x}, ${display.camera.y} · ${display.camera.width} × ${display.camera.height} DIP`
                        : 'None'}
                    </p>
                    <p className="break-all">UUID: {display.uuid ?? 'Unavailable'}</p>
                  </div>
                </div>
              ))}
            </div>
          </details>
        )}
      </section>
      {overlay.previewSessions.length > 0 && (
        <section className="mt-4 rounded-2xl border border-border bg-card p-4">
          <h2 className="mb-4 text-sm font-semibold">Preview sessions</h2>
          <PreviewSessions snapshot={snapshot} />
        </section>
      )}
      <p className="mt-5 text-xs leading-5 text-muted-foreground">
        Synthetic sessions only. Nothing is recorded or sent to your coding agents. Restarting Buddy
        clears the preview.
      </p>
    </>
  )
}
