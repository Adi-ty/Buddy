import { useEffect, useState } from 'react'
import type { SessionRecord } from '@shared/contracts'
import { COMPLETION_NOTICE_MS } from '@shared/sessions'

// Refresh only when the next completion notice expires, including a quiet
// source that sends no subsequent events. Background heartbeats don't extend it.
export function useSessionClock(sessions: readonly SessionRecord[] = [], showElapsed = false) {
  const [expiry, setExpiry] = useState(0)
  useEffect(() => {
    const now = Date.now()
    const next = sessions
      .filter((session) => session.status === 'completed')
      .map((session) => session.statusChangedAt + COMPLETION_NOTICE_MS)
      .filter((at) => at > now)
      .sort((a, b) => a - b)[0]
    if (next === undefined) return
    const timer = setTimeout(() => setExpiry((revision) => revision + 1), next - now + 1)
    return () => clearTimeout(timer)
  }, [sessions, expiry])
  useEffect(() => {
    if (!showElapsed || !sessions.some((session) => session.status === 'working')) return
    const timer = setInterval(() => setExpiry((revision) => revision + 1), 5000)
    return () => clearInterval(timer)
  }, [showElapsed, sessions])
  return Date.now()
}
