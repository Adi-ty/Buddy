import { Component, useEffect, type ReactNode } from 'react'
import { MemoryRouter, NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import {
  ArrowRight,
  Circle,
  Clock3,
  Cpu,
  History,
  Layers3,
  Plug,
  Monitor,
  Sparkles,
} from 'lucide-react'
import type { BuddySnapshot } from '@shared/contracts'
import { AvatarPreviewTile } from '@/components/avatar-preview'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { OverlayView } from '@/components/overlay-view'
import { OverlayPreviewPage } from '@/components/overlay-preview-page'
import { useBuddySnapshot } from '@/lib/use-buddy-snapshot'

const navigation = [
  { path: '/sessions', label: 'Sessions', icon: Layers3 },
  { path: '/history', label: 'History', icon: History },
  { path: '/integrations', label: 'Integrations', icon: Plug },
  { path: '/overlay-preview', label: 'Overlay preview', icon: Monitor },
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
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <aside className="sidebar">
        <div className="titlebar-drag h-[68px]" aria-hidden="true" />
        <div className="flex items-center gap-3 px-6 pb-8 pt-3">
          <div className="buddy-mark" aria-hidden="true">
            <span />
            <span />
          </div>
          <div>
            <div className="text-lg font-semibold tracking-tight">Buddy</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              A little closer to your work
            </div>
          </div>
        </div>
        <nav aria-label="Dashboard" className="space-y-1 px-3">
          {navigation
            .filter(
              (item) => snapshot.runtime.overlayPreviewEnabled || item.path !== '/overlay-preview',
            )
            .map(({ path, label, icon: Icon }) => (
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
          <div className="rounded-xl border border-border p-3.5">
            <div className="flex items-center gap-2 text-xs font-medium">
              <Circle size={7} className="text-muted-foreground" aria-hidden="true" /> Awaiting
              connections
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              Your sessions will appear here once a source is connected.
            </p>
          </div>
          <div className="mt-4 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Made for your Mac</span>
            <span>v{snapshot.runtime.appVersion}</span>
          </div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="titlebar-drag h-[68px] shrink-0" aria-hidden="true" />
        <main id="main-content" className="main-content" tabIndex={-1}>
          <Routes>
            <Route path="/sessions" element={<SessionsPage snapshot={snapshot} />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/integrations" element={<IntegrationsPage snapshot={snapshot} />} />
            {snapshot.runtime.overlayPreviewEnabled && (
              <Route path="/overlay-preview" element={<OverlayPreviewPage snapshot={snapshot} />} />
            )}
            <Route path="*" element={<Navigate to="/sessions" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}

function PageHeading({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children?: ReactNode
}) {
  return (
    <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-[27px] font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{subtitle}</p>
      </div>
      {children}
    </header>
  )
}

function SessionsPage({ snapshot }: { snapshot: BuddySnapshot }) {
  const navigate = useNavigate()
  return (
    <>
      <PageHeading
        title="Your sessions"
        subtitle="A quiet place to see what’s happening, and what needs you."
      >
        <Badge variant="outline">No sources connected</Badge>
      </PageHeading>
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Open sessions', detail: 'Live session presence', icon: Layers3 },
          { label: 'Working turns', detail: 'Observed agent activity', icon: Cpu },
          { label: 'Needs attention', detail: 'Requests that need you', icon: Sparkles },
        ].map(({ label, detail, icon: Icon }) => (
          <div key={label} className="rounded-2xl border border-border p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Icon size={14} aria-hidden="true" />
              {label}
            </div>
            <div className="my-3 text-2xl text-muted-foreground" aria-label="Not available">
              —
            </div>
            <p className="text-[11px] text-muted-foreground">{detail}</p>
          </div>
        ))}
      </div>
      <section className="empty-stage mt-5" aria-labelledby="sessions-empty-heading">
        <div className="flex items-end justify-center gap-5 pb-8 pt-2">
          {snapshot.avatarPreviews.map((preview, index) => {
            const harness = snapshot.harnesses.find((item) => item.id === preview.harness)!
            return (
              <AvatarPreviewTile
                key={preview.harness}
                preview={preview}
                harness={harness}
                className={cn(index === 1 ? 'size-[76px] -translate-y-3' : 'size-16')}
              />
            )
          })}
        </div>
        <h2 id="sessions-empty-heading" className="text-xl font-semibold tracking-tight">
          A face for every session.
        </h2>
        <p className="mx-auto mt-3 max-w-[370px] text-sm leading-6 text-muted-foreground">
          Connect your coding agents to keep their sessions in view. Buddy stays out of the way
          until there’s something to see.
        </p>
        <Button className="mt-6" onClick={() => navigate('/integrations')}>
          View integrations <ArrowRight />
        </Button>
        <p className="mt-5 text-[11px] text-muted-foreground">
          Avatar previews · Bottts Neutral by DiceBear, artwork by Pablo Stanley
        </p>
      </section>
      <p className="mt-5 flex items-center gap-2 text-xs leading-5 text-muted-foreground">
        <Circle size={8} aria-hidden="true" /> Installed tools, open sessions, and working turns are
        tracked separately.
      </p>
    </>
  )
}

function HistoryPage() {
  return (
    <>
      <PageHeading
        title="History"
        subtitle="Conversations you’ve seen with Buddy, separate from live sessions."
      />
      <section className="empty-stage" aria-labelledby="history-empty-heading">
        <div className="mb-5 inline-flex size-14 items-center justify-center rounded-2xl border border-border bg-secondary">
          <Clock3 size={24} className="text-muted-foreground" aria-hidden="true" />
        </div>
        <h2 id="history-empty-heading" className="text-xl font-semibold">
          Nothing here yet.
        </h2>
        <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
          No conversations have been recorded by Buddy. Your agents’ existing history hasn’t been
          imported.
        </p>
      </section>
    </>
  )
}

function IntegrationsPage({ snapshot }: { snapshot: BuddySnapshot }) {
  return (
    <>
      <PageHeading
        title="Integrations"
        subtitle="Each agent connects in its own way. Each client is verified separately."
      />
      <div className="space-y-3">
        {snapshot.harnesses.map((harness) => {
          const preview = snapshot.avatarPreviews.find((item) => item.harness === harness.id)!
          return (
            <section
              key={harness.id}
              aria-labelledby={`harness-${harness.id}`}
              className="rounded-2xl border border-border bg-card p-5"
            >
              <div className="flex items-start gap-5">
                <AvatarPreviewTile preview={preview} harness={harness} className="size-12" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 id={`harness-${harness.id}`} className="font-semibold">
                      {harness.name}
                    </h2>
                    <Badge variant="outline">Not connected</Badge>
                  </div>
                  <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
                    {harness.description}
                  </p>
                  <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
                    <span>Installation: not checked</span>
                    <span>Session awareness: unavailable</span>
                  </div>
                </div>
              </div>
            </section>
          )
        })}
      </div>
      <div className="mt-6 rounded-xl border border-dashed border-border px-4 py-3 text-xs leading-5 text-muted-foreground">
        Integration setup is coming in a later step. Buddy hasn’t changed any agent configuration.
      </div>
    </>
  )
}
