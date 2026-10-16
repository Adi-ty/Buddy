import { useEffect, useRef, useState } from 'react'
import { Check, Copy, LoaderCircle, Pause, Play, Send, Unplug } from 'lucide-react'
import type { TelegramPairing, TelegramStatus } from '@shared/telegram'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'
import { Notice } from './ui/notice'

const states = {
  disconnected: ['Not connected', 'outline'],
  validating: ['Connecting', 'working'],
  pairing: ['Awaiting pairing', 'attention'],
  connected: ['Connected', 'success'],
  offline: ['Reconnecting', 'attention'],
  suspended: ['Sleeping', 'outline'],
  conflict: ['Connection conflict', 'error'],
  error: ['Connection issue', 'error'],
} as const

const categories = [
  ['permissions', 'Approvals'],
  ['questions', 'Questions'],
  ['completions', 'Completed sessions'],
  ['failures', 'Failed sessions'],
] as const

type Action = 'connect' | 'pair' | 'preferences' | 'reconnect' | 'disconnect'
const setupFailure = 'Couldn’t complete setup. Check your connection and try again.'

export function TelegramSettings({ status }: { status?: TelegramStatus }) {
  const token = useRef<HTMLInputElement>(null)
  const busy = useRef(false)
  const [pending, setPending] = useState<Action | null>(null)
  const [pairing, setPairing] = useState<TelegramPairing | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [now, setNow] = useState(Date.now())
  const paired = Boolean(status?.botUsername && status.pairedUser)
  const pairingReady = status?.state === 'pairing'
  const connecting = pending === 'connect' || status?.state === 'validating'
  const disabled = pending !== null || !status || connecting
  const remaining = pairing ? Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000)) : 0
  const activeLink = pairingReady && pairing !== null && remaining > 0
  const needsAttention =
    status && ['offline', 'suspended', 'conflict', 'error'].includes(status.state)
  const [stateLabel, stateVariant] = status
    ? states[status.state]
    : (['Loading', 'outline'] as const)

  useEffect(() => {
    if (!pairingReady || paired) {
      setPairing(null)
      setCopied(false)
    }
  }, [pairingReady, paired, status?.botUsername])
  useEffect(() => {
    if (!pairing) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [pairing])
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2500)
    return () => clearTimeout(timer)
  }, [copied])

  const act = async (action: Action, operation: () => Promise<unknown>) => {
    if (busy.current) return
    busy.current = true
    setPending(action)
    setError(null)
    try {
      await operation()
    } catch {
      // Never display IPC errors: transport URLs can contain credentials.
      setError(
        action === 'preferences'
          ? 'Couldn’t save your notification settings. Try again.'
          : action === 'disconnect'
            ? 'Couldn’t finish disconnecting. Try again.'
            : setupFailure,
      )
    } finally {
      busy.current = false
      setPending(null)
    }
  }
  const generateLink = () =>
    act('pair', async () => {
      setPairing(null)
      setCopied(false)
      const link = await window.buddy.pairTelegram()
      setNow(Date.now())
      setPairing(link)
    })
  const copyLink = async () => {
    if (!activeLink || !pairing || pairing.expiresAt <= Date.now()) return
    setError(null)
    setCopied(false)
    try {
      await window.buddy.copyTelegramPairingLink(pairing.url)
      setCopied(true)
    } catch {
      setError('Couldn’t copy the link. Select it and press ⌘C.')
    }
  }

  return (
    <section
      className="overflow-hidden rounded-2xl border border-border bg-card"
      aria-label="Telegram companion"
    >
      {confirmDisconnect && (
        <ConfirmDialog
          title="Disconnect Telegram?"
          action="Disconnect"
          pending={pending !== null}
          onCancel={() => setConfirmDisconnect(false)}
          onConfirm={() =>
            void act('disconnect', async () => {
              await window.buddy.disconnectTelegram()
              setPairing(null)
              setConfirmDisconnect(false)
            })
          }
        >
          Telegram notifications and replies will stop. You’ll need to pair again to reconnect.
          <Notice className="mt-3" message={error ? { error: true, text: error } : null} />
        </ConfirmDialog>
      )}
      <div className="flex flex-wrap items-center gap-3 p-5">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-secondary text-foreground">
          <Send className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">Telegram</h2>
          <p className="mt-1 break-all text-xs text-muted-foreground">
            {status?.botUsername ? `@${status.botUsername}` : 'Take your companion with you.'}
          </p>
        </div>
        <Badge variant={stateVariant}>
          {connecting && <LoaderCircle size={12} className="animate-spin" aria-hidden="true" />}
          <span role="status">{stateLabel}</span>
        </Badge>
      </div>

      <div className="space-y-4 border-t border-border p-5">
        {needsAttention && <Notice message={{ error: true, text: status.message }} />}
        {paired && status?.deliveryProblem && !needsAttention && (
          <Notice
            message={{
              error: true,
              text: 'Some messages couldn’t be delivered or updated. Check pending requests in Buddy.',
            }}
          />
        )}

        {!status?.botUsername && (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              if (disabled) return
              const value = token.current?.value.trim() ?? ''
              if (!value) return
              if (token.current) token.current.value = ''
              void act('connect', async () => {
                const link = await window.buddy.connectTelegram(value)
                setNow(Date.now())
                setPairing(link)
              })
            }}
          >
            <div>
              <p className="text-sm font-medium">Connect your bot</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                In Telegram, send <span className="font-mono text-foreground">/newbot</span> to the
                verified <span className="font-medium text-foreground">@BotFather</span>, then paste
                the token below.
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-0 flex-1 text-xs font-medium">
                Bot token
                <input
                  ref={token}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={160}
                  disabled={disabled}
                  required
                  placeholder="Paste your token"
                  className="mt-2 block h-10 w-full min-w-48 rounded-xl border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                />
              </label>
              <Button type="submit" disabled={disabled}>
                {connecting && <LoaderCircle className="animate-spin" aria-hidden="true" />}
                {connecting ? 'Connecting…' : 'Connect bot'}
              </Button>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              Session and request details will be shared with Telegram. Your token is stored
              encrypted on this Mac.
            </p>
          </form>
        )}

        {status?.botUsername && !paired && (
          <div className="space-y-3">
            <div>
              <p className="text-sm font-medium">Pair your Telegram account</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Open the link in Telegram and tap{' '}
                <span className="font-medium text-foreground">Start</span>.
              </p>
            </div>
            {activeLink ? (
              <>
                <div className="flex flex-wrap gap-2">
                  <input
                    readOnly
                    value={pairing.url}
                    onFocus={(event) => event.target.select()}
                    aria-label="Telegram pairing link"
                    className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <Button variant="outline" disabled={disabled} onClick={() => void copyLink()}>
                    {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                    {copied ? 'Copied' : 'Copy link'}
                  </Button>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    Private, one-use link · Expires in {Math.floor(remaining / 60)}:
                    {String(remaining % 60).padStart(2, '0')}
                  </p>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => void generateLink()}
                  >
                    Replace link
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <Button disabled={disabled || !pairingReady} onClick={() => void generateLink()}>
                  {pending === 'pair' && (
                    <LoaderCircle className="animate-spin" aria-hidden="true" />
                  )}
                  {pending === 'pair' ? 'Generating…' : 'Generate pairing link'}
                </Button>
                {pairing && remaining === 0 && (
                  <p className="text-xs text-muted-foreground" role="status">
                    Link expired. Generate a new one.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {paired && status && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Paired with</p>
                <p className="mt-1 break-words text-sm font-medium">{status.pairedUser}</p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() =>
                  void act('preferences', () =>
                    window.buddy.setTelegramPreferences({
                      ...status.preferences,
                      paused: !status.preferences.paused,
                    }),
                  )
                }
              >
                {status.preferences.paused ? (
                  <Play aria-hidden="true" />
                ) : (
                  <Pause aria-hidden="true" />
                )}
                {status.preferences.paused ? 'Resume notifications' : 'Pause notifications'}
              </Button>
            </div>
            {status.preferences.paused && (
              <p
                className="rounded-xl bg-secondary px-3 py-2 text-xs leading-5 text-muted-foreground"
                role="status"
              >
                New notifications are paused. Existing requests still work while pending.
              </p>
            )}
            <fieldset className="space-y-3" disabled={disabled}>
              <legend className="text-xs font-medium">Send to Telegram</legend>
              <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                {categories.map(([key, label]) => (
                  <label
                    className="flex cursor-pointer items-center justify-between gap-3 text-sm has-disabled:cursor-default"
                    key={key}
                  >
                    {label}
                    <span className="relative inline-flex shrink-0">
                      <input
                        type="checkbox"
                        role="switch"
                        className="peer sr-only"
                        checked={status.preferences[key]}
                        onChange={(event) => {
                          const preferences = { ...status.preferences, [key]: event.target.checked }
                          void act('preferences', () =>
                            window.buddy.setTelegramPreferences(preferences),
                          )
                        }}
                      />
                      <span
                        aria-hidden="true"
                        className="h-5 w-9 rounded-full border border-border bg-secondary transition-colors peer-checked:border-primary peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-card peer-disabled:opacity-50"
                      />
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute left-0.5 top-0.5 size-4 rounded-full bg-foreground/60 transition-transform peer-checked:translate-x-4 peer-checked:bg-primary-foreground peer-disabled:opacity-50"
                      />
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          </>
        )}
        {!confirmDisconnect && (!needsAttention || error !== setupFailure) && (
          <Notice message={error ? { error: true, text: error } : null} />
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3">
        <p className="text-xs text-muted-foreground">
          Keep Buddy running and your Mac awake and online.
        </p>
        {status && status.state !== 'disconnected' && (
          <div className="flex gap-1">
            {needsAttention && status.botUsername && (
              <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => void act('reconnect', () => window.buddy.reconnectTelegram())}
              >
                {pending === 'reconnect' ? 'Reconnecting…' : 'Reconnect'}
              </Button>
            )}
            <Button
              variant="danger"
              size="sm"
              disabled={disabled}
              onClick={() => {
                setError(null)
                setConfirmDisconnect(true)
              }}
            >
              <Unplug aria-hidden="true" />
              {pending === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </div>
        )}
      </div>
      <details className="border-t border-border px-5 py-3 text-xs leading-5 text-muted-foreground">
        <summary className="w-fit cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Privacy & reply support
        </summary>
        <p className="mt-2">
          Telegram receives session and request details. Full conversations aren’t collected, and
          disconnecting won’t delete your Telegram chat history.
        </p>
        <p className="mt-2">
          Enable “Reply from the companion” for your agent to answer requests. Unsupported requests
          stay in the agent. Buddy needs an internet connection and access to the agent.
        </p>
      </details>
    </section>
  )
}
