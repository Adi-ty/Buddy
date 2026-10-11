import type { HarnessId, SessionStatus } from '../../shared/contracts'
import { isHarnessId } from '../../shared/harnesses'
import { ADAPTERS } from './adapters'

export interface Observation {
  id: string
  harness: HarnessId
  source: 'hooks' | 'plugin'
  sessionId: string
  parentId: string | null
  event: string
  at: number
  cwd: string | null
  name: string | null
  turnId: string | null
  tool: string | null
  requestId: string | null
  status: SessionStatus | null
  attention: readonly { id: string; kind: 'permission' | 'question' }[] | null
  action: 'observe' | 'metadata' | 'close' | 'permission' | 'question' | 'resolve'
  clearPermissionHints?: boolean
  idleCompletesTurn?: boolean
  preserveErrorOnCompletion?: boolean
}

export function textField(value: unknown, limit = 256): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= limit &&
    !/[\u0000-\u001f]/.test(value)
    ? value
    : null
}

// External reporters send allowlisted metadata. Main validates it again and
// assigns semantics; renderer IPC never accepts provider observations.
export function normalizeObservation(value: unknown, now = Date.now()): Observation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const p = value as Record<string, unknown>
  if (p.version !== 1 || !isHarnessId(p.harness)) return null
  const harness = p.harness as HarnessId
  const id = textField(p.id)
  const event = textField(p.event)
  const sessionId = textField(p.sessionId, 128)
  if (
    !id ||
    !event ||
    !sessionId ||
    typeof p.at !== 'number' ||
    !Number.isFinite(p.at) ||
    p.at > now + 5000 ||
    p.at < now - 60_000
  )
    return null
  const adapter = ADAPTERS[harness]
  const mapped = adapter.mapEvent(p, { sessionId, parentId: textField(p.parentId), textField })
  if (!mapped) return null
  const parentId = mapped.parentId ?? textField(p.parentId)
  return {
    id,
    harness,
    source: adapter.source,
    sessionId: mapped.sessionId ?? sessionId,
    parentId: parentId === (mapped.sessionId ?? sessionId) ? null : parentId,
    event,
    at: p.at,
    cwd: textField(p.cwd, 2048),
    name: mapped.name ?? null,
    turnId: mapped.turnId === undefined ? textField(p.turnId) : mapped.turnId,
    tool: textField(p.tool, 120),
    requestId: textField(p.requestId),
    status: mapped.status,
    attention: mapped.attention ?? null,
    action: mapped.action,
    clearPermissionHints: mapped.clearPermissionHints,
    idleCompletesTurn: mapped.idleCompletesTurn,
    preserveErrorOnCompletion: mapped.preserveErrorOnCompletion,
  }
}
