import { harnessFor } from '@/lib/harness'
import { Component, useEffect, useState, type ReactNode } from 'react'
import { MemoryRouter, NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { ArrowRight, History, Layers3, Plug, Settings } from 'lucide-react'
import type { BuddySnapshot } from '@shared/contracts'
import { SessionAvatar } from '@/components/session-avatar'
import { SessionList } from '@/components/session-list'
import { IntegrationsPage } from '@/components/integrations-page'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { OverlayView } from '@/components/overlay-view'
import { PageHeading } from '@/components/ui/page-heading'
import { SettingsPage } from '@/components/settings-page'
import { TrackingNotice } from '@/components/tracking-notice'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useBuddySnapshot } from '@/lib/use-buddy-snapshot'
import { useNotice } from '@/lib/use-notice'
import { Notice } from '@/components/ui/notice'
import buddyLogo from '../../../resources/buddy-brand.png'

const navigation = [
  { path: '/sessions', label: 'Sessions', icon: Layers3 },
  { path: '/history', label: 'History', icon: History },
  { path: '/integrations', label: 'Integrations', icon: Plug },
  { path: '/settings', label: 'Settings', icon: Settings },
] as const

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  render(): ReactNode {
    if (this.state.failed) return <StartupFailure />
    return this.props.children
  }
}

function StartupFailure() {
  return (
    <div className="flex min-h-screen items-center justify-center p-12">
      <div className="max-w-sm space-y-4">
        <h1 className="text-xl font-semibold">Buddy couldn’t load the dashboard.</h1>
        <p className="text-sm leading-6 text-muted-foreground">
          Reload to reconnect to the app. If this keeps happening, quit Buddy and launch it again.
        </p>
        <Button onClick={() => window.location.reload()}>Reload dashboard</Button>
      </div>
    </div>
  )
}

export function App() {
  return (
    <ErrorBoundary>
      <MemoryRouter>
        {window.location.hash === '#overlay' ? <OverlayView /> : <Dashboard />}
      </MemoryRouter>
    </ErrorBoundary>
  )
}

function Dashboard() {
  const { snapshot, failed } = useBuddySnapshot()
  const navigate = useNavigate()

  useEffect(() => window.buddy.onNavigate((route) => navigate(route)), [navigate])

  if (failed) return <StartupFailure />
  if (!snapshot)
    return (
      <div
        className="flex min-h-screen items-center justify-center text-sm text-muted-foreground"
        role="status"
      >
        Opening Buddy…
      </div>
    )

  return (
    <div className="dashboard-shell">
      <a
        href="#main-content"
        className="skip-link"
        onClick={(event) => {
          event.preventDefault()
          document.getElementById('main-content')?.focus()
        }}
      >
        Skip to content
      </a>
      <aside className="sidebar">
        <div className="titlebar-drag h-[68px]" aria-hidden="true" />
        <div className="flex items-center gap-3 px-6 pb-8 pt-3">
          <img
            src={buddyLogo}
            alt=""
            width={44}
            height={44}
            className="shrink-0 rounded-xl object-contain"
            aria-hidden="true"
          />
          <div>
            <div className="text-lg font-semibold tracking-tight">Buddy</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">Your agents, at a glance</div>
          </div>
        </div>
        <nav aria-label="Dashboard" className="space-y-1 px-3">
          {navigation.map(({ path, label, icon: Icon }) => (
            <NavLink
              key={path}
              to={path}
              className={({ isActive }) => cn('nav-link', isActive && 'nav-link-active')}
            >
              <Icon size={17} aria-hidden="true" />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto p-5">
          <div className="mt-4 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Made for your Mac</span>
            <span>v{snapshot.runtime.appVersion}</span>
          </div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="titlebar-drag h-[68px] shrink-0" aria-hidden="true" />
        <main id="main-content" className="main-content" tabIndex={-1}>
          <TrackingNotice tracking={snapshot.tracking} />
          {snapshot.overlay.message && (
            <Notice
              className="mb-4"
              message={{
                text: snapshot.overlay.message,
                error: snapshot.overlay.geometry === 'unavailable',
              }}
            />
          )}
          <Routes>
            <Route path="/sessions" element={<SessionsPage snapshot={snapshot} />} />
            <Route path="/history" element={<HistoryPage snapshot={snapshot} />} />
            <Route path="/integrations" element={<IntegrationsPage snapshot={snapshot} />} />
            <Route path="/settings" element={<SettingsPage snapshot={snapshot} />} />
            <Route path="*" element={<Navigate to="/sessions" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}

function SessionsPage({ snapshot }: { snapshot: BuddySnapshot }) {
  const navigate = useNavigate()
  const connected = snapshot.harnesses.filter((item) => item.observer === 'installed')
  return (
    <>
      <PageHeading
        title="Sessions"
        subtitle="Observed activity from your agents. Requests, errors and finished turns appear first."
      >
        <Button variant="outline" size="sm" onClick={() => navigate('/integrations')}>
          <Plug /> Manage integrations
        </Button>
      </PageHeading>
      {snapshot.sessions.length > 0 ? (
        <>
          <SessionList snapshot={snapshot} />
        </>
      ) : (
        <section className="empty-stage" aria-labelledby="sessions-empty-heading">
          <div className="flex items-end justify-center gap-5 pb-8 pt-2" aria-hidden="true">
            {snapshot.avatarPreviews.map((avatar, index) => (
              <SessionAvatar
                key={avatar.harness}
                avatar={avatar}
                harness={harnessFor(snapshot, avatar.harness)}
                className={cn(index === 1 ? 'size-[76px] -translate-y-3' : 'size-16')}
              />
            ))}
          </div>
          <h2 id="sessions-empty-heading" className="text-xl font-semibold tracking-tight">
            {connected.length ? 'Ready for your next session' : 'Connect your first agent'}
          </h2>
          <p className="mx-auto mt-3 max-w-[390px] text-sm leading-6 text-muted-foreground">
            {connected.length
              ? `Start a session in ${connected.map((item) => item.name).join(' or ')}. If you just installed the observer, restart the agent and follow its setup instructions in Integrations.`
              : 'Install an observer to see your agent’s activity and permission requests in the companion.'}
          </p>
          <Button className="mt-6" onClick={() => navigate('/integrations')}>
            {connected.length ? 'Check integrations' : 'Set up integrations'} <ArrowRight />
          </Button>
          <p className="mt-5 text-xs text-muted-foreground">
            The companion appears automatically when a session sends activity.
          </p>
        </section>
      )}
    </>
  )
}

function HistoryPage({ snapshot }: { snapshot: BuddySnapshot }) {
  const [confirm, setConfirm] = useState(false)
  const [pending, setPending] = useState(false)
  const { notice, setNotice, reportError } = useNotice()
  const clear = async () => {
    setPending(true)
    try {
      await window.buddy.clearHistory()
      setConfirm(false)
      setNotice({
        text: 'Past session metadata and avatar identities cleared. Live sessions are retained.',
        error: false,
      })
    } catch (error) {
      reportError(error, 'History could not be cleared.')
    } finally {
      setPending(false)
    }
  }
  return (
    <>
      <PageHeading title="History" subtitle="Sessions that have ended or stopped sending activity.">
        <Button
          variant="danger"
          size="sm"
          title={
            !snapshot.history.length
              ? 'No past sessions to clear'
              : !snapshot.tracking.available
                ? 'History cannot be changed while storage is unavailable'
                : undefined
          }
          disabled={pending || !snapshot.history.length || !snapshot.tracking.available}
          onClick={() => setConfirm(true)}
        >
          Clear history
        </Button>
      </PageHeading>
      {confirm && (
        <ConfirmDialog
          title="Clear session history?"
          action="Clear past sessions"
          pending={pending}
          onConfirm={() => void clear()}
          onCancel={() => setConfirm(false)}
        >
          Clear {snapshot.history.length} past sessions and their saved avatars? Live sessions stay
          connected.
        </ConfirmDialog>
      )}
      {!snapshot.history.length && (
        <p className="mb-3 text-sm text-muted-foreground">
          No past sessions yet. Ended sessions appear here; active sessions stay in Sessions.
        </p>
      )}
      {!snapshot.tracking.available && (
        <p className="mb-3 text-xs text-muted-foreground">
          History cannot be changed while storage is unavailable.
        </p>
      )}
      <Notice message={notice} className="mb-3" />
      <SessionList snapshot={snapshot} history />
      <p className="mt-5 text-xs text-muted-foreground">
        Retains up to 2,000 session records across live sessions and history. Existing agent
        conversations are not imported.
      </p>
    </>
  )
}
