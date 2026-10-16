import type { SessionRecord } from '../../shared/contracts'
import type { HarnessId } from '../../shared/harnesses'
import { sessionFamilies } from '../../shared/session-families'
import { ADAPTERS } from '../tracking/adapters'

function label(value: string | undefined, fallback: string): string {
  const text = value?.replace(/\s+/g, ' ').trim() || fallback
  return text.length > 160 ? `${text.slice(0, 159).replace(/[\uD800-\uDBFF]$/, '')}…` : text
}

export function sessionContext(
  session: SessionRecord | undefined,
  sessions: readonly SessionRecord[],
  harness?: HarnessId,
): string {
  const root = session ? sessionFamilies([session], sessions)[0]!.root : undefined
  const agent = session?.harness ?? harness
  const child = session?.parentId && session.parentId !== session.id
  return [
    `Session: ${label(root === session && child ? undefined : root?.name, 'Unavailable')}`,
    ...(child ? [`Subagent: ${label(session.name, 'Unnamed subagent')}`] : []),
    `Agent: ${agent ? (ADAPTERS[agent]?.name ?? 'Unknown agent') : 'Unknown agent'}`,
    `Project: ${label(session?.project, 'Unavailable')}`,
  ].join('\n')
}

export function turnMessage(session: SessionRecord, sessions: readonly SessionRecord[]): string {
  const child = session.parentId && session.parentId !== session.id
  const heading = session.status === 'completed' ? '✅' : '❌'
  const outcome = session.status === 'completed' ? 'finished' : 'failed'
  return `${heading} ${child ? 'Subagent turn' : 'Turn'} ${outcome}\n\n${sessionContext(session, sessions)}`
}
