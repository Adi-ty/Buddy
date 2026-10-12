import type { AgentRequest, SessionRecord } from './contracts'
import { prioritizeSessions } from './sessions'

export interface SessionFamily {
  root: SessionRecord
  members: SessionRecord[]
  descendants: SessionRecord[]
  // Presentation only: canonical records retain their own semantic status.
  summary: SessionRecord
}

// Opening a family should lead to the agent waiting for input, including a
// nested child. Ended descendants remain available only through explicit selection.
export function familyInputSession(
  family: SessionFamily,
  requests: readonly AgentRequest[] = [],
): SessionRecord {
  const members = new Map(family.members.map((member) => [member.id, member]))
  const pending = requests
    .filter((request) => members.has(request.sessionId))
    .sort((a, b) => a.createdAt - b.createdAt)[0]
  return (
    (pending && members.get(pending.sessionId)) ||
    prioritizeSessions(family.members).find((member) => member.status === 'needs-attention') ||
    family.root
  )
}

export function sessionFamilies(
  records: readonly SessionRecord[],
  context: readonly SessionRecord[] = records,
  now = Date.now(),
): SessionFamily[] {
  const known = new Map([...context, ...records].map((record) => [record.id, record]))
  const roots = new Map<string, SessionRecord>()
  const rootFor = (record: SessionRecord): SessionRecord => {
    const cached = roots.get(record.id)
    if (cached) return cached
    const chain = [record]
    const seen = new Set([record.id])
    let root = record
    while (root.parentId) {
      const parent = known.get(root.parentId)
      if (!parent || parent.harness !== record.harness) break
      if (seen.has(parent.id)) {
        // Malformed cycles get one deterministic family, never a hidden row.
        root = chain
          .slice(chain.findIndex((item) => item.id === parent.id))
          .sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id))[0]!
        break
      }
      const ancestor = roots.get(parent.id)
      if (ancestor) {
        root = ancestor
        break
      }
      seen.add(parent.id)
      chain.push(parent)
      root = parent
    }
    for (const item of chain) roots.set(item.id, root)
    return root
  }
  const groups = new Map<string, SessionFamily>()
  for (const record of records) {
    const root = rootFor(record)
    const group = groups.get(root.id) ?? { root, members: [], descendants: [], summary: root }
    group.members.push(record)
    groups.set(root.id, group)
  }
  for (const record of known.values()) {
    const root = rootFor(record)
    if (record.id !== root.id) groups.get(root.id)?.descendants.push(record)
  }
  for (const group of groups.values()) {
    group.descendants.sort((a, b) => a.ordinal - b.ordinal)
    const ordered = prioritizeSessions(group.members, now)
    const signal = ordered.find((item) => ['needs-attention', 'error'].includes(item.status))
    const working = ordered.find((item) => item.status === 'working')
    const lead = signal ?? working ?? ordered[0]!
    group.summary = {
      ...group.root,
      status: lead.status,
      statusChangedAt: lead.statusChangedAt,
      attention: lead.attention,
      lastSeen: Math.max(...group.members.map((item) => item.lastSeen)),
    }
  }
  const order = new Map(
    prioritizeSessions(
      [...groups.values()].map((group) => group.summary),
      now,
    ).map((item, i) => [item.id, i]),
  )
  return [...groups.values()].sort((a, b) => order.get(a.root.id)! - order.get(b.root.id)!)
}

export function relativeTime(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  return seconds < 60
    ? 'just now'
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ago`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)}h ago`
        : `${Math.floor(seconds / 86400)}d ago`
}
