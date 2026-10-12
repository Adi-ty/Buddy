import type { SessionRecord } from './contracts'

export const sessionStatusLabels: Record<SessionRecord['status'], string> = {
  working: 'Working',
  idle: 'Idle',
  completed: 'Finished',
  'needs-attention': 'Needs attention',
  error: 'Error',
  interrupted: 'Interrupted',
  unknown: 'Unknown',
}

export type SessionSignal = 'attention' | 'success' | 'error'
export const COMPLETION_NOTICE_MS = 12_000

export function notchRecords(records: readonly SessionRecord[], now = Date.now()): SessionRecord[] {
  return records.filter(
    (record) =>
      record.status !== 'completed' || now - record.statusChangedAt < COMPLETION_NOTICE_MS,
  )
}

export function sessionSignal(status: SessionRecord['status']): SessionSignal | undefined {
  if (status === 'needs-attention') return 'attention'
  if (status === 'completed') return 'success'
  if (status === 'error') return 'error'
  return undefined
}

export function sessionNotification(
  session: SessionRecord,
  now = Date.now(),
): SessionSignal | undefined {
  if (session.status === 'completed' && now - session.statusChangedAt >= COMPLETION_NOTICE_MS)
    return undefined
  return sessionSignal(session.status)
}

export function notchSignal(
  records: readonly SessionRecord[],
  now = Date.now(),
): SessionSignal | undefined {
  if (records.some((record) => record.status === 'needs-attention')) return 'attention'
  if (records.some((record) => record.status === 'error')) return 'error'
  if (records.some((record) => sessionNotification(record, now) === 'success')) return 'success'
  return undefined
}

export function signalRevision(
  records: readonly SessionRecord[],
  signal?: SessionSignal,
  now = Date.now(),
): string {
  return records
    .filter((record) => sessionNotification(record, now) === signal)
    .map(
      (record) =>
        `${record.id}:${record.statusChangedAt}:${record.attention.map((a) => a.id).join(',')}`,
    )
    .join('|')
}

// Surface requests, failures and finished turns; ordinary activity keeps its order.
export function prioritizeSessions(
  records: readonly SessionRecord[],
  now = Date.now(),
): SessionRecord[] {
  const priority = (record: SessionRecord): number =>
    record.status === 'needs-attention'
      ? 0
      : record.status === 'error'
        ? 1
        : sessionNotification(record, now) === 'success'
          ? 2
          : 3
  return [...records].sort((a, b) => priority(a) - priority(b) || a.ordinal - b.ordinal)
}

export function sessionAttentionLabel(session: SessionRecord): string | null {
  if (session.status !== 'needs-attention') return null
  const request = session.attention[0]
  if (!request) return 'Waiting for you'
  return request.kind === 'question'
    ? 'Waiting for your answer'
    : request.tool
      ? `Permission for ${request.tool}`
      : 'Waiting for permission'
}

export function sessionLastTool(session: SessionRecord): string | null {
  return [...session.activity].reverse().find((activity) => activity.tool)?.tool ?? null
}
