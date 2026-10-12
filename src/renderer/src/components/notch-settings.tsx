import { useState } from 'react'
import { Monitor, RefreshCw } from 'lucide-react'
import type { BuddySnapshot } from '@shared/contracts'
import { Button } from './ui/button'
import { Select } from './ui/select'
import { Notice } from './ui/notice'
import { useNotice } from '@/lib/use-notice'

export function NotchSettings({ snapshot }: { snapshot: BuddySnapshot }) {
  const { notice, setNotice } = useNotice()
  const [busy, setBusy] = useState(false)
  const { overlay } = snapshot
  const automaticDisplay =
    overlay.displays.find((display) => display.builtIn && display.camera) ??
    overlay.displays.find((display) => display.builtIn) ??
    overlay.displays[0]
  const placedDisplay =
    overlay.displays.find((display) => display.id === overlay.anchorId) ??
    overlay.displays.find((display) => display.id === overlay.displayId) ??
    automaticDisplay
  const act = async (action: Promise<void>) => {
    setBusy(true)
    setNotice(null)
    try {
      await action
    } catch {
      setNotice({ error: true, text: 'Couldn’t update notch placement. Try again.' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <details className="mt-6 rounded-xl border border-border px-4 py-3 text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <Monitor size={13} /> Notch placement
        </span>
      </summary>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {overlay.displays.length > 1 ? (
          <Select
            aria-label="Notch display"
            value={overlay.displayId ?? 'auto'}
            disabled={busy || !overlay.displays.length}
            onChange={(event) =>
              void act(
                window.buddy.setOverlayOptions({
                  displayId: event.target.value === 'auto' ? null : Number(event.target.value),
                }),
              )
            }
          >
            <option value="auto">Automatic · {automaticDisplay?.name}</option>
            {overlay.displayId !== null &&
              !overlay.displays.some((display) => display.id === overlay.displayId) && (
                <option value={overlay.displayId}>Disconnected display</option>
              )}
            {overlay.displays.map((display) => (
              <option key={display.id} value={display.id}>
                {display.name}
              </option>
            ))}
          </Select>
        ) : (
          <span className="text-muted-foreground">
            {placedDisplay
              ? `${placedDisplay.name} · Only connected display`
              : 'Finding your display…'}
          </span>
        )}
        {overlay.displays.length <= 1 && overlay.displayId !== null && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void act(window.buddy.setOverlayOptions({ displayId: null }))}
          >
            Use automatic placement
          </Button>
        )}
        {overlay.geometry === 'unavailable' && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void act(window.buddy.refreshDisplays())}
          >
            <RefreshCw /> Retry placement
          </Button>
        )}
      </div>
      {overlay.displays.length > 1 && placedDisplay && (
        <p className="mt-3 text-muted-foreground" role="status">
          {overlay.displayId === null ? 'Automatic placement' : 'Pinned display'} ·{' '}
          {placedDisplay.name}
        </p>
      )}
      <p className="mt-3 leading-5 text-muted-foreground">
        Hover or click the notch to see sessions.{' '}
        {overlay.shortcutAvailable && 'Use ⌘⇧Space to open the dashboard.'}
      </p>
      <Notice
        className="mt-3"
        message={
          notice ??
          (overlay.message
            ? { text: overlay.message, error: overlay.geometry === 'unavailable' }
            : null)
        }
      />
    </details>
  )
}
