import { Notification } from 'electron'
import type { SessionRecord } from '../shared/contracts'
import { sessionAttentionLabel } from '../shared/sessions'
import { runTask } from './tasks'

type NativeNotice = Pick<Notification, 'on' | 'show' | 'close'>

export class SessionNotifications {
  private pending = new Map<string, SessionRecord>()
  private live = new Map<string, NativeNotice>()
  private errors = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | null = null
  constructor(
    private readonly enabled: () => boolean,
    private readonly openDashboard: () => void,
    private readonly create: (options: { title: string; body: string }) => NativeNotice = (
      options,
    ) => new Notification(options),
  ) {}

  private unmap(id: string): void {
    const notice = this.live.get(id)
    this.live.delete(id)
    if (!notice || [...this.live.values()].includes(notice)) return
    try {
      notice.close()
    } catch {
      /* Native delivery is best effort. */
    }
  }

  observe(before: SessionRecord | null, after: SessionRecord | null, now = Date.now()): void {
    if (!this.enabled()) return this.reset()
    const id = after?.id ?? before?.id
    if (!id) return
    if (!after || after.presence !== 'observed' || after.status !== before?.status) {
      this.pending.delete(id)
      this.unmap(id)
    }
    if (!after || after.presence !== 'observed' || after.status === before?.status) return
    if (after.status === 'error') {
      if (now - (this.errors.get(id) ?? -Infinity) < 60_000) return
      this.errors.delete(id)
      this.errors.set(id, now)
      if (this.errors.size > 10_000) this.errors.delete(this.errors.keys().next().value!)
    } else if (after.status !== 'needs-attention') return
    this.pending.set(id, after)
    if (!this.timer) {
      this.timer = setTimeout(() => runTask('Desktop notification', () => this.flush()), 500)
      this.timer.unref?.()
    }
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const sessions = [...this.pending.values()]
    this.pending.clear()
    if (!sessions.length || !this.enabled()) return
    try {
      const one = sessions[0]!
      const waiting = sessions.filter((session) => session.status === 'needs-attention').length
      const errors = sessions.length - waiting
      const notice = this.create(
        sessions.length === 1
          ? {
              title: one.name,
              body: `${sessionAttentionLabel(one) ?? 'Check your agent'} · ${one.project}`,
            }
          : {
              title: 'Buddy',
              body: [
                waiting ? `${waiting} sessions need your attention` : '',
                errors ? `${errors} sessions reported an error` : '',
              ]
                .filter(Boolean)
                .join('. '),
            },
      )
      notice.on('click', () => {
        try {
          this.openDashboard()
        } catch {
          /* No automatic focus on delivery. */
        }
      })
      const clear = (): void => {
        for (const [id, item] of this.live) if (item === notice) this.live.delete(id)
      }
      notice.on('close', clear)
      notice.on('failed', clear)
      for (const session of sessions) this.live.set(session.id, notice)
      notice.show()
    } catch {
      /* Unsigned builds and notification preferences may prevent delivery. */
    }
  }

  reconcileObserved(records: readonly SessionRecord[]): void {
    const observed = new Set(records.map((record) => record.id))
    for (const id of new Set([...this.pending.keys(), ...this.live.keys()])) {
      if (observed.has(id)) continue
      this.pending.delete(id)
      this.unmap(id)
    }
  }

  reset(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
    for (const notice of new Set(this.live.values())) {
      try {
        notice.close()
      } catch {
        /* Already unavailable. */
      }
    }
    this.live.clear()
  }
}
