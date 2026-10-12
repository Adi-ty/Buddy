import { useEffect, useState } from 'react'
import type { BuddySnapshot } from '@shared/contracts'
import { NotchSettings } from './notch-settings'
import { PageHeading } from './ui/page-heading'
import { Notice } from './ui/notice'
import { useNotice } from '@/lib/use-notice'

export function SettingsPage({ snapshot }: { snapshot: BuddySnapshot }) {
  const [pending, setPending] = useState(false)
  const { notice, reportError } = useNotice()
  const [preferences, setPreferences] = useState(snapshot.preferences)
  useEffect(() => setPreferences(snapshot.preferences), [snapshot.preferences])
  const change = async (key: 'desktopNotifications' | 'launchAtLogin', enabled: boolean) => {
    setPending(true)
    setPreferences((current) => (current ? { ...current, [key]: enabled } : current))
    try {
      await window.buddy.setPreference(key, enabled)
    } catch (error) {
      setPreferences(snapshot.preferences)
      reportError(error, 'Couldn’t save this setting. Try again.')
    } finally {
      setPending(false)
    }
  }
  return (
    <>
      <PageHeading title="Settings" subtitle="Choose how Buddy appears and notifies you." />
      <section
        className="space-y-5 rounded-2xl border border-border bg-card p-5"
        aria-label="App preferences"
      >
        <label className="flex items-center justify-between gap-4">
          <span>
            <span className="block text-sm font-medium">Desktop notifications</span>
            <span className="mt-1 block text-xs text-muted-foreground">
              Notify when an agent needs attention or encounters an error.
            </span>
          </span>
          <input
            type="checkbox"
            checked={preferences?.desktopNotifications ?? true}
            disabled={pending || !preferences}
            onChange={(event) => void change('desktopNotifications', event.target.checked)}
          />
        </label>
        <label className="flex items-center justify-between gap-4">
          <span>
            <span className="block text-sm font-medium">Launch at login</span>
            <span className="mt-1 block text-xs text-muted-foreground">
              {preferences?.canLaunchAtLogin
                ? 'Keep Buddy available when you sign in to your Mac.'
                : 'Available in the installed app. Development builds start manually.'}
            </span>
          </span>
          <input
            type="checkbox"
            checked={preferences?.launchAtLogin ?? false}
            disabled={pending || !preferences?.canLaunchAtLogin}
            onChange={(event) => void change('launchAtLogin', event.target.checked)}
          />
        </label>
        <Notice message={notice} />
      </section>
      <NotchSettings snapshot={snapshot} />
    </>
  )
}
