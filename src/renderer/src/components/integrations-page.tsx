import { harnessFor, avatarFor } from '@/lib/harness'
import { useState } from 'react'
import { Check, LoaderCircle, Plug, RefreshCw, Trash2 } from 'lucide-react'
import type { BuddySnapshot, HarnessId } from '@shared/contracts'
import { SessionAvatar } from './session-avatar'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { PageHeading } from './ui/page-heading'
import { Notice } from './ui/notice'
import { useNotice } from '@/lib/use-notice'
import { useEffect } from 'react'
import { relativeTime } from '@shared/session-families'
import { errorMessage } from '@shared/error-message'
import { ConfirmDialog } from './ui/confirm-dialog'

export function IntegrationsPage({ snapshot }: { snapshot: BuddySnapshot }) {
  const [pending, setPending] = useState<string | null>(null)
  const [removing, setRemoving] = useState<HarnessId | null>(null)
  const [noticeScope, setNoticeScope] = useState<HarnessId | null>(null)
  const { notice, setNotice } = useNotice()
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])
  const act = async (
    action:
      | 'install'
      | 'install-unverified'
      | 'remove'
      | 'refresh'
      | 'enable-controls'
      | 'disable-controls',
    harness?: HarnessId,
  ) => {
    setPending(harness ?? 'refresh')
    setNoticeScope(harness ?? null)
    setNotice(null)
    try {
      if (action === 'refresh') {
        await window.buddy.refreshIntegrations()
        setNotice({ error: false, text: 'Integrations refreshed.' })
      } else if (harness) {
        if (action === 'enable-controls' || action === 'disable-controls') {
          await window.buddy.setIntegrationControls(harness, action === 'enable-controls')
          setNotice({
            error: false,
            text:
              action === 'enable-controls'
                ? harness === 'codex'
                  ? 'Native Codex replies enabled. Connecting to its local app server.'
                  : `Notch replies enabled. ${harness === 'opencode' ? 'Restart OpenCode once to load the updated plugin.' : 'Restart your agent once to load the response hooks.'}`
                : 'Notch replies disabled. Pending requests return to your agent.',
          })
          return
        }
        if (action === 'install' || action === 'install-unverified')
          await window.buddy.installIntegration(harness, action === 'install-unverified')
        else {
          await window.buddy.removeIntegration(harness)
          setRemoving(null)
        }
        const entry = harnessFor(snapshot, harness)
        setNotice({
          error: false,
          text:
            action !== 'remove'
              ? `Observer installed. ${entry.installNotice ?? `Restart ${entry.name} to start tracking.`}`
              : (entry.removeNotice ??
                `Observer removed. Restart ${entry.name} to finish disconnecting.`),
        })
      }
    } catch (error) {
      setNotice({
        error: true,
        text: errorMessage(error, 'Setup failed. Try again.'),
      })
    } finally {
      setPending(null)
    }
  }
  return (
    <>
      <PageHeading
        title="Integrations"
        subtitle="Connect your agents to keep their sessions in the notch."
      >
        <Button
          variant="outline"
          size="sm"
          disabled={pending !== null}
          onClick={() => void act('refresh')}
        >
          {pending === 'refresh' ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}{' '}
          Refresh
        </Button>
      </PageHeading>
      <Notice className="mb-4" message={noticeScope === null ? notice : null} />
      {removing && (
        <ConfirmDialog
          title={`Remove ${harnessFor(snapshot, removing).name} observer?`}
          action="Remove observer"
          pending={pending !== null}
          onCancel={() => setRemoving(null)}
          onConfirm={() => void act('remove', removing)}
        >
          Session tracking and notch replies will stop for this agent. Your agent’s other settings
          will be retained.
          <Notice className="mt-3" message={noticeScope === removing ? notice : null} />
        </ConfirmDialog>
      )}
      <div className="space-y-3">
        {snapshot.harnesses.map((harness) => {
          const installed = harness.observer === 'installed'
          const incomplete = harness.observer === 'incomplete'
          const receiving = harness.connection === 'observed'
          const canInstall =
            snapshot.tracking.available &&
            harness.installation === 'installed' &&
            harness.canInstall
          return (
            <section key={harness.id} className="rounded-2xl border border-border bg-card p-5">
              <div className="flex items-start gap-4">
                <SessionAvatar
                  avatar={avatarFor(snapshot, harness.id)}
                  harness={harness}
                  className="size-11"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="font-semibold">{harness.name}</h2>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {harness.version
                          ? `CLI ${harness.version}`
                          : harness.installation === 'not-checked'
                            ? 'Checking installation…'
                            : 'CLI not found'}
                      </p>
                    </div>
                    <Badge variant={installed ? 'success' : incomplete ? 'attention' : 'outline'}>
                      {installed && <Check size={12} />}
                      {installed
                        ? 'Observer installed'
                        : incomplete
                          ? 'Setup incomplete'
                          : 'Not connected'}
                    </Badge>
                  </div>
                  <p className="mt-4 text-sm leading-6 text-muted-foreground">
                    {installed && receiving
                      ? 'Connected. Sessions are appearing in your notch.'
                      : harness.setup}
                  </p>
                  <Notice
                    className="mt-3"
                    message={
                      harness.configurationError
                        ? { error: true, text: harness.configurationError }
                        : null
                    }
                  />
                  {harness.compatibility === 'unverified' && (
                    <p className="mt-2 text-xs leading-5 text-attention">
                      Version {harness.version} isn’t verified — Buddy’s event contract may
                      misreport activity.{' '}
                      {installed
                        ? 'This observer is unverified.'
                        : 'Install only if you want to test this version.'}
                    </p>
                  )}
                  {harness.lastEventAt !== undefined && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Last event {relativeTime(harness.lastEventAt, now)}
                    </p>
                  )}
                  {installed && (
                    <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                      <span
                        className={`status-dot ${receiving ? 'status-dot-connected' : ''}`}
                        aria-hidden="true"
                      />
                      {receiving
                        ? 'Receiving activity'
                        : harness.connection === 'stale'
                          ? 'No recent activity. Waiting for the next session event.'
                          : 'Ready. Waiting for the first session event.'}
                    </p>
                  )}
                  {installed && (
                    <div className="mt-4 rounded-xl border border-border p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-xs font-medium">Reply from the notch</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Approvals and structured questions.
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant={harness.controls ? 'outline' : 'default'}
                          disabled={
                            pending !== null ||
                            !snapshot.tracking.available ||
                            (!harness.controls && !harness.canInstall)
                          }
                          onClick={() =>
                            void act(
                              harness.controls ? 'disable-controls' : 'enable-controls',
                              harness.id,
                            )
                          }
                        >
                          {harness.controls ? <Check /> : null}
                          {harness.controls ? 'Disable replies' : 'Enable replies'}
                        </Button>
                      </div>
                      <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
                        {harness.controls
                          ? 'Enabled. Buddy shows commands and questions only while they await your response.'
                          : 'Review each request and allow once, deny, or answer. Your agent’s existing permission rules still apply.'}
                      </p>
                      {harness.id === 'codex' &&
                        harness.controls &&
                        harness.controlsConnection !== 'connected' && (
                          <p
                            className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"
                            role="status"
                          >
                            {harness.controlsConnection === 'connecting' ? (
                              <LoaderCircle size={12} className="animate-spin" />
                            ) : null}
                            {harness.controlsMessage}
                          </p>
                        )}
                    </div>
                  )}
                  <div className="mt-4 flex gap-2">
                    {!installed && !(harness.canInstallUnverified && !harness.canInstall) && (
                      <Button
                        size="sm"
                        disabled={pending !== null || !canInstall}
                        onClick={() => void act('install', harness.id)}
                      >
                        {pending === harness.id ? (
                          <LoaderCircle className="animate-spin" />
                        ) : (
                          <Plug />
                        )}
                        {incomplete ? 'Repair observer' : 'Install observer'}
                      </Button>
                    )}
                    {!installed && harness.canInstallUnverified && !harness.canInstall && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending !== null || !snapshot.tracking.available}
                        onClick={() => void act('install-unverified', harness.id)}
                      >
                        Install anyway (unverified)
                      </Button>
                    )}
                    {(installed || incomplete) && (
                      <Button
                        variant="danger"
                        size="sm"
                        disabled={pending !== null}
                        onClick={() => setRemoving(harness.id)}
                      >
                        {pending === harness.id ? (
                          <LoaderCircle className="animate-spin" />
                        ) : (
                          <Trash2 />
                        )}{' '}
                        Remove observer
                      </Button>
                    )}
                  </div>
                  <Notice className="mt-3" message={noticeScope === harness.id ? notice : null} />
                </div>
              </div>
            </section>
          )
        })}
      </div>
      <details className="mt-6 text-xs leading-6 text-muted-foreground">
        <summary className="cursor-pointer font-medium text-foreground">What Buddy tracks</summary>
        <p className="mt-2">
          Session names, IDs, project paths, activity timestamps and tool names. Observation does
          not collect your prompts, tool outputs or conversations. Setup preserves your existing
          settings and saves a backup.
        </p>
        <p className="mt-2">
          With notch replies enabled, pending tool arguments and structured questions are shown
          locally in Buddy. They and your answers are kept in memory, then discarded when the
          request ends.
        </p>
        <p className="mt-2">
          Observers run on this Mac. Desktop and IDE clients need to load the same hooks or plugin;
          remote sessions are not connected.
        </p>
      </details>
    </>
  )
}
