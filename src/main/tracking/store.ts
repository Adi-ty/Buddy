import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname } from 'node:path'
import type { HarnessId, SessionRecord } from '../../shared/contracts'
import { sessionAvatar } from '../avatars'
import { isHarnessId } from '../../shared/harnesses'
import { ADAPTERS } from './adapters'
import { textField, type Observation } from './events'

interface StoredSession extends Omit<SessionRecord, 'dataUri'> {
  seed: string
  lastEventAt: number
  lastStateAt?: number
  lastPresenceAt: number
  seen: string[]
  nameSource?: 'harness' | 'fallback'
}
interface Identity {
  id: string
  seed: string
  ordinal: number
  lastUsedAt?: number
}
const STALE_AFTER = 10 * 60_000
const MAX_RECORDS = 2000
const MAX_RETIRED_IDENTITIES = 10_000
const RETRY_AFTER = 30_000
const key = (harness: string, id: string): string => `${harness}:${id}`
const fallbackName = (harness: HarnessId, ordinal: number): string =>
  ADAPTERS[harness].displayName(ordinal)

export class SessionStore {
  private records = new Map<string, StoredSession>()
  private ordinal = 0
  private avatars = new Map<string, string>()
  private identities = new Map<string, Identity>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private dirty = false
  private retryAt = 0
  private nameCursor = 0
  droppedObservations = 0
  capacityEvictions = 0
  message: string | null = null

  constructor(
    private readonly path: string,
    private readonly lookupName: (
      harness: HarnessId,
      id: string,
      cwd?: string | null,
    ) => string | null = () => null,
    private readonly options: {
      flushDelayMs?: number
      onPersistenceError?: () => void
    } = {},
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    if (!existsSync(path)) return
    // Invalid data is preserved for recovery instead of silently overwritten.
    const data = JSON.parse(readFileSync(path, 'utf8')) as {
      version: number
      records: StoredSession[]
      identities?: Identity[]
      nextOrdinal?: number
    }
    if (data.version !== 1 || !Array.isArray(data.records) || data.records.length > MAX_RECORDS)
      throw new Error('Unsupported or damaged session store')
    const identities: Identity[] =
      data.identities ?? data.records.map(({ id, seed, ordinal }) => ({ id, seed, ordinal }))
    if (!Array.isArray(identities)) throw new Error('Invalid avatar identity store')
    for (const identity of identities) {
      if (
        !identity ||
        !textField(identity.id) ||
        !textField(identity.seed) ||
        !Number.isSafeInteger(identity.ordinal) ||
        identity.ordinal < 0 ||
        (identity.lastUsedAt !== undefined &&
          (!Number.isFinite(identity.lastUsedAt) || identity.lastUsedAt < 0)) ||
        this.identities.has(identity.id)
      )
        throw new Error('Invalid avatar identity')
      this.identities.set(identity.id, {
        id: identity.id,
        seed: identity.seed,
        ordinal: identity.ordinal,
        lastUsedAt: identity.lastUsedAt ?? 0,
      })
      this.ordinal = Math.max(this.ordinal, identity.ordinal + 1)
    }
    for (const record of data.records) {
      if (!validRecord(record) || this.records.has(record.id))
        throw new Error('Invalid persisted session')
      const identity = this.identities.get(record.id)
      if (identity && (identity.seed !== record.seed || identity.ordinal !== record.ordinal))
        throw new Error('Session identity mismatch')
      this.identities.set(record.id, {
        id: record.id,
        seed: record.seed,
        ordinal: record.ordinal,
        lastUsedAt: record.lastSeen,
      })
      this.ordinal = Math.max(this.ordinal, record.ordinal + 1)
      this.records.set(record.id, {
        ...record,
        // Older builds used the project folder as the session name.
        name:
          record.nameSource !== 'harness' && record.name === record.project
            ? fallbackName(record.harness, record.ordinal)
            : record.name,
        statusChangedAt: record.statusChangedAt ?? record.lastEventAt,
        lastStateAt: record.lastStateAt ?? record.lastEventAt,
        presence: record.presence === 'closed' ? 'closed' : 'stale',
        turnActive: record.presence === 'closed' ? false : undefined,
        status: record.presence === 'closed' ? record.status : 'unknown',
        attention: [],
      })
    }
    if (data.nextOrdinal !== undefined) {
      if (!Number.isSafeInteger(data.nextOrdinal) || data.nextOrdinal < this.ordinal)
        throw new Error('Invalid identity ordinal')
      this.ordinal = data.nextOrdinal
    }
    this.pruneIdentities(this.records)
  }

  private pruneIdentities(records: Map<string, StoredSession>): void {
    const retired = [...this.identities.values()]
      .filter((item) => !records.has(item.id))
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || b.ordinal - a.ordinal)
    for (const identity of retired.slice(MAX_RETIRED_IDENTITIES))
      this.identities.delete(identity.id)
  }

  private persist(records: Map<string, StoredSession>): void {
    const identities = new Map(this.identities)
    for (const { id, seed, ordinal, lastSeen } of records.values())
      identities.set(id, { id, seed, ordinal, lastUsedAt: lastSeen })
    const retired = [...identities.values()]
      .filter((identity) => !records.has(identity.id))
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || b.ordinal - a.ordinal)
      .slice(0, MAX_RETIRED_IDENTITIES)
    const nextOrdinal = Math.max(this.ordinal, ...[...records.values()].map((r) => r.ordinal + 1))
    const temporary = `${this.path}.tmp`
    const fd = openSync(temporary, 'w', 0o600)
    try {
      writeFileSync(
        fd,
        JSON.stringify({
          version: 1,
          records: [...records.values()],
          nextOrdinal,
          identities: retired,
        }),
      )
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, this.path)
    const directory = openSync(dirname(this.path), 'r')
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
    this.identities = new Map(
      [
        ...retired,
        ...[...records.values()].map(({ id, seed, ordinal, lastSeen }) => ({
          id,
          seed,
          ordinal,
          lastUsedAt: lastSeen,
        })),
      ].map((identity) => [identity.id, identity]),
    )
  }

  private failed(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.message =
      'Session data could not be saved. Observation is paused; Buddy will retry in 30 seconds.'
    this.retryAt = Date.now() + RETRY_AFTER
    this.options.onPersistenceError?.()
  }

  // A bounded window, rather than resetting a debounce on every event, also
  // flushes under a continuous stream. New identities are always saved first.
  private scheduleFlush(): void {
    this.dirty = true
    if (this.message || this.flushTimer) return
    if (!this.options.flushDelayMs) return this.flushSync()
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      try {
        this.flushSync()
      } catch {
        /* failed() already latched service health. */
      }
    }, this.options.flushDelayMs)
    this.flushTimer.unref?.()
  }

  flush(): void {
    this.flushSync()
  }

  flushSync(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    if (!this.dirty) return
    try {
      this.persist(this.records)
      this.dirty = false
      this.message = null
    } catch (error) {
      this.failed()
      throw error
    }
  }

  retryPersistence(now = Date.now()): boolean {
    if (!this.message || now < this.retryAt) return false
    this.dirty = true
    try {
      this.flushSync()
      return true
    } catch {
      return false
    }
  }

  dispose(): void {
    try {
      this.flushSync()
    } catch {
      /* Keep existing durable data for recovery. */
    }
  }

  apply(event: Observation, receivedAt = Date.now()): boolean {
    if (this.message) {
      this.droppedObservations++
      return false
    }
    const id = key(event.harness, event.sessionId)
    const existing = this.records.get(id)
    const identity = this.identities.get(id)
    if (
      existing?.seen.includes(event.id) ||
      (existing &&
        event.at <
          (event.action === 'metadata'
            ? existing.lastEventAt
            : (existing.lastStateAt ?? existing.lastEventAt)))
    )
      return false
    if (
      existing?.turnId &&
      event.turnId &&
      existing.turnId !== event.turnId &&
      !['UserPromptSubmit', 'SessionStart', 'SubagentStart'].includes(event.event)
    )
      return false
    // A late closing event must not resurrect an unknown conversation.
    if (!existing && event.action === 'close') return false
    const record: StoredSession = existing
      ? structuredClone(existing)
      : {
          id,
          providerSessionId: event.sessionId,
          harness: event.harness,
          source: event.source,
          client: 'unknown',
          seed: identity?.seed ?? randomUUID(),
          name: fallbackName(event.harness, identity?.ordinal ?? this.ordinal),
          nameSource: 'fallback',
          project: event.cwd ? basename(event.cwd) || event.cwd : 'Unknown project',
          cwd: event.cwd,
          parentId: event.parentId ? key(event.harness, event.parentId) : null,
          status: 'unknown',
          statusChangedAt: event.at,
          presence: 'observed',
          firstSeen: receivedAt,
          lastSeen: receivedAt,
          ordinal: identity?.ordinal ?? this.ordinal,
          turnId: null,
          attention: [],
          activity: [],
          lastEventAt: 0,
          lastStateAt: 0,
          lastPresenceAt: 0,
          seen: [],
        }
    record.lastSeen = receivedAt
    if (event.source === 'app-server') record.source = 'app-server'
    const freshMetadata = event.at >= record.lastEventAt
    record.lastEventAt = Math.max(record.lastEventAt, event.at)
    record.seen = [...record.seen.slice(-127), event.id]
    if (event.action !== 'metadata') {
      record.lastStateAt = event.at
      record.presence = event.action === 'close' ? 'closed' : 'observed'
      record.lastPresenceAt = receivedAt
    } else if (!existing) record.presence = 'stale'
    if (freshMetadata && event.cwd) {
      record.cwd = event.cwd
      record.project = basename(event.cwd) || event.cwd
    }
    const name =
      event.source === 'app-server' && event.name
        ? event.name
        : record.source === 'app-server' && record.nameSource === 'harness'
          ? null
          : (this.lookupName(event.harness, event.sessionId, record.cwd) ?? event.name)
    if (freshMetadata && name) {
      record.name = name
      record.nameSource = 'harness'
    }
    if (freshMetadata && event.parentId) record.parentId = key(event.harness, event.parentId)
    if (
      event.event === 'UserPromptSubmit' ||
      event.event === 'SubagentStart' ||
      (event.status === 'working' &&
        !['working', 'needs-attention'].includes(existing?.status ?? 'unknown'))
    )
      record.turnStartedAt = event.at
    if (event.turnId) record.turnId = event.turnId
    if (event.turnActive !== undefined) record.turnActive = event.turnActive
    else if (event.status === 'error') record.turnActive = undefined
    else if (event.status === 'working') record.turnActive = true
    else if (event.action === 'close' || ['completed', 'interrupted'].includes(event.status ?? ''))
      record.turnActive = false
    if (event.event === 'UserPromptSubmit' || event.event === 'SessionStart') record.attention = []
    if (event.action === 'permission' || event.action === 'question') {
      const request = event.requestId ?? event.tool ?? 'uncorrelated'
      record.attention = [
        ...record.attention.filter((item) => item.id !== request),
        { id: request, tool: event.tool, kind: event.action },
      ].slice(-32)
    } else if (event.action === 'resolve') {
      // Never clear unrelated parallel permission requests.
      const exact = event.requestId && record.attention.some((item) => item.id === event.requestId)
      record.attention = record.attention.filter(
        (item) =>
          item.id !== event.requestId &&
          (exact ||
            item.kind !== 'permission' ||
            item.id !== (item.tool ?? 'uncorrelated') ||
            (item.tool !== null && item.tool !== event.tool)),
      )
      if (!record.attention.length) record.status = 'unknown'
    } else if (event.clearPermissionHints) {
      // Codex PermissionRequest does not guarantee a tool-call ID. Such a
      // request is an observation hint, not an authoritative pending queue.
      // Fresh same-turn tool activity supersedes it, including clients that
      // omit PostToolUse. Requests with explicit IDs remain independently pending.
      record.attention = record.attention.filter(
        (item) => item.kind !== 'permission' || item.id !== (item.tool ?? 'uncorrelated'),
      )
    } else if (['PostToolUse', 'PostToolUseFailure'].includes(event.event)) {
      record.attention = record.attention.filter((item) => {
        if (event.requestId && item.id === event.requestId) return false
        // PermissionRequest may lack the ID that PostToolUse supplies.
        const hint = item.id === (item.tool ?? 'uncorrelated')
        return !(hint && (item.tool === null || item.tool === event.tool))
      })
    }
    if (
      event.action === 'close' ||
      ['Stop', 'StopFailure', 'SubagentStop', 'Interrupt'].includes(event.event) ||
      event.status === 'interrupted'
    )
      record.attention = []
    if (event.status !== null) {
      // An initial idle observation is not a completed turn. OpenCode reports
      // completion as busy -> idle; periodic idle reconciliation keeps it done.
      if (event.status === 'idle' && event.idleCompletesTurn) {
        if (['working', 'needs-attention', 'completed'].includes(record.status))
          record.status = 'completed'
        else if (!['error', 'interrupted'].includes(record.status)) record.status = 'idle'
      } else if (
        !event.preserveErrorOnCompletion ||
        !['error', 'interrupted'].includes(record.status)
      )
        record.status = event.status
    }
    if (event.attention !== null)
      record.attention = event.attention.map((item) => ({ ...item, tool: null }))
    if (record.attention.length) record.status = 'needs-attention'
    if (
      record.status !== existing?.status ||
      (event.status === 'error' && record.status === 'error')
    )
      record.statusChangedAt = event.at
    record.activity = [
      ...record.activity.slice(-19),
      { event: event.event, at: event.at, tool: event.tool },
    ]
    const next = new Map(this.records)
    next.set(id, record)
    if (event.action === 'close') {
      // A parent's end invalidates descendant presence; it doesn't establish
      // that each child completed successfully.
      const ancestors = new Set([id])
      let found = true
      while (found) {
        found = false
        for (const [childId, child] of next)
          if (child.parentId && ancestors.has(child.parentId) && !ancestors.has(childId)) {
            ancestors.add(childId)
            if (child.presence !== 'closed')
              next.set(childId, {
                ...child,
                presence: 'stale',
                turnActive: undefined,
                status: 'unknown',
                attention: [],
                lastEventAt: Math.max(child.lastEventAt, event.at),
                lastStateAt: Math.max(child.lastStateAt ?? child.lastEventAt, event.at),
              })
            found = true
          }
      }
    }
    if (next.size > MAX_RECORDS) {
      const oldest =
        [...next.values()]
          .filter((item) => item.presence !== 'observed')
          .sort((a, b) => a.lastSeen - b.lastSeen || a.ordinal - b.ordinal)[0] ??
        [...next.values()].sort((a, b) => a.lastSeen - b.lastSeen || a.ordinal - b.ordinal)[0]!
      if (oldest.presence === 'observed') this.capacityEvictions++
      next.delete(oldest.id)
      this.avatars.delete(oldest.seed)
    }
    if (!existing && !identity) {
      try {
        this.persist(next)
      } catch (error) {
        this.failed()
        throw error
      }
    }
    this.records = next
    if (!existing && !identity) this.ordinal++
    if (existing || identity) this.scheduleFlush()
    return true
  }

  expire(now = Date.now(), all = false): boolean {
    const next = new Map(this.records)
    let changed = false
    for (const [id, record] of next)
      if (record.presence === 'observed' && (all || now - record.lastPresenceAt > STALE_AFTER)) {
        next.set(id, {
          ...record,
          presence: 'stale',
          status: 'unknown',
          turnActive: undefined,
          attention: [],
        })
        changed = true
      }
    if (changed) {
      this.records = next
      if (!this.message) this.scheduleFlush()
    }
    return changed
  }

  resolveControlAttention(
    id: string,
    requestId: string,
    tool: string | null,
    turnId: string | null,
    allowed: boolean,
  ): void {
    const record = this.records.get(id)
    if (
      !record ||
      record.presence !== 'observed' ||
      ['completed', 'interrupted'].includes(record.status) ||
      (turnId && record.turnId && turnId !== record.turnId)
    )
      return
    const attention = record.attention.filter(
      (item) =>
        item.id !== requestId &&
        !(
          item.kind === 'permission' &&
          item.id === (item.tool ?? 'uncorrelated') &&
          (item.tool === tool || item.tool === null)
        ),
    )
    this.records.set(id, {
      ...record,
      attention,
      status: attention.length ? 'needs-attention' : allowed ? 'working' : 'unknown',
      turnActive: allowed ? true : record.turnActive,
      statusChangedAt: Date.now(),
      lastEventAt: Math.max(record.lastEventAt, Date.now()),
      lastStateAt: Math.max(record.lastStateAt ?? record.lastEventAt, Date.now()),
    })
    this.scheduleFlush()
  }

  refreshNames(limit = 32): boolean {
    if (this.message) return false
    const next = new Map(this.records)
    let changed = false
    const entries = [...next.entries()]
    const count = Math.min(limit, entries.length)
    for (let offset = 0; offset < count; offset++) {
      const [id, record] = entries[(this.nameCursor + offset) % entries.length]!
      if (record.source === 'app-server' && record.nameSource === 'harness') continue
      const name = this.lookupName(record.harness, record.providerSessionId, record.cwd)
      if (name && (name !== record.name || record.nameSource !== 'harness')) {
        next.set(id, { ...record, name, nameSource: 'harness' })
        changed = true
      }
    }
    this.nameCursor = entries.length ? (this.nameCursor + count) % entries.length : 0
    if (changed) {
      this.records = next
      this.scheduleFlush()
    }
    return changed
  }

  clearHistory(): void {
    if (this.message) throw new Error('History cannot be cleared while persistence is unavailable')
    const next = new Map([...this.records].filter(([, record]) => record.presence === 'observed'))
    // Explicit deletion discards retired identities too; live identities remain.
    const oldIdentities = this.identities
    this.identities = new Map([...oldIdentities].filter(([id]) => next.has(id)))
    try {
      this.persist(next)
    } catch (error) {
      this.identities = oldIdentities
      this.failed()
      throw error
    }
    this.records = next
    this.dirty = false
    const retained = new Set([...next.values()].map((record) => record.seed))
    for (const seed of this.avatars.keys()) if (!retained.has(seed)) this.avatars.delete(seed)
  }

  get(id: string): SessionRecord | null {
    const stored = this.records.get(id)
    if (!stored) return null
    const {
      seed,
      seen: _seen,
      lastEventAt: _at,
      lastStateAt: _state,
      lastPresenceAt: _presence,
      nameSource: _name,
      ...record
    } = stored
    let dataUri = this.avatars.get(seed)
    if (!dataUri) {
      dataUri = sessionAvatar(seed, record.ordinal)
      this.avatars.set(seed, dataUri)
    }
    return { ...record, dataUri }
  }

  lastEventAt(harness: HarnessId): number | undefined {
    const times = [...this.records.values()]
      .filter((record) => record.harness === harness)
      .map((record) => record.lastEventAt)
    return times.length ? Math.max(...times) : undefined
  }

  snapshot(includeHistoryAvatars = true): { sessions: SessionRecord[]; history: SessionRecord[] } {
    const records = [...this.records.values()]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map(
        ({
          seed,
          seen: _seen,
          lastEventAt: _at,
          lastStateAt: _state,
          lastPresenceAt: _presence,
          nameSource: _name,
          ...record
        }) => {
          if (!includeHistoryAvatars && record.presence !== 'observed')
            return { ...record, dataUri: '' }
          let dataUri = this.avatars.get(seed)
          if (!dataUri) {
            dataUri = sessionAvatar(seed, record.ordinal)
            this.avatars.set(seed, dataUri)
          }
          return { ...record, dataUri }
        },
      )
    return {
      sessions: records.filter((item) => item.presence === 'observed'),
      history: records.filter((item) => item.presence !== 'observed'),
    }
  }
}

function validRecord(r: StoredSession): boolean {
  return (
    !!r &&
    textField(r.id) !== null &&
    textField(r.providerSessionId) !== null &&
    textField(r.seed) !== null &&
    isHarnessId(r.harness) &&
    r.id === key(r.harness, r.providerSessionId) &&
    ['hooks', 'plugin', 'app-server'].includes(r.source) &&
    r.client === 'unknown' &&
    textField(r.name) !== null &&
    (r.nameSource === undefined || ['harness', 'fallback'].includes(r.nameSource)) &&
    (r.statusChangedAt === undefined ||
      (Number.isFinite(r.statusChangedAt) && r.statusChangedAt >= 0)) &&
    (r.turnStartedAt === undefined || (Number.isFinite(r.turnStartedAt) && r.turnStartedAt >= 0)) &&
    (r.turnActive === undefined || typeof r.turnActive === 'boolean') &&
    (r.lastStateAt === undefined ||
      (Number.isFinite(r.lastStateAt) && r.lastStateAt >= 0 && r.lastStateAt <= r.lastEventAt)) &&
    textField(r.project, 2048) !== null &&
    (r.cwd === null || textField(r.cwd, 2048) !== null) &&
    (r.parentId === null || textField(r.parentId) !== null) &&
    ['working', 'idle', 'completed', 'needs-attention', 'error', 'interrupted', 'unknown'].includes(
      r.status,
    ) &&
    ['observed', 'stale', 'closed'].includes(r.presence) &&
    [r.firstSeen, r.lastSeen, r.lastEventAt, r.lastPresenceAt].every(
      (n) => Number.isFinite(n) && n >= 0,
    ) &&
    Number.isSafeInteger(r.ordinal) &&
    r.ordinal >= 0 &&
    (r.turnId === null || textField(r.turnId) !== null) &&
    Array.isArray(r.seen) &&
    r.seen.length <= 128 &&
    r.seen.every((s) => textField(s) !== null) &&
    Array.isArray(r.activity) &&
    r.activity.length <= 20 &&
    r.activity.every(
      (a) =>
        textField(a.event) !== null &&
        Number.isFinite(a.at) &&
        (a.tool === null || textField(a.tool, 120) !== null),
    ) &&
    Array.isArray(r.attention) &&
    r.attention.length <= 32 &&
    r.attention.every(
      (a) =>
        textField(a.id) !== null &&
        ['permission', 'question'].includes(a.kind) &&
        (a.tool === null || textField(a.tool, 120) !== null),
    )
  )
}
