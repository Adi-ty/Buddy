import { useEffect, useRef } from 'react'
import type { BuddySnapshot, HarnessCatalogEntry, SessionRecord } from '@shared/contracts'
import { harnessFor } from '@/lib/harness'
import { RequestPanel } from './request-panel'

export function SessionRequests({
  session,
  snapshot,
  overlay = false,
}: {
  session: SessionRecord
  snapshot: BuddySnapshot
  overlay?: boolean
}) {
  const panel = useRef<HTMLDivElement>(null)
  const requests = (snapshot.requests ?? []).filter((request) => request.sessionId === session.id)
  const requestIds = requests.map((request) => request.id).join('|')
  useEffect(() => {
    if (overlay && requestIds) panel.current?.scrollIntoView({ block: 'start' })
  }, [overlay, session.id, requestIds])
  if (requests.length)
    return (
      <div ref={panel}>
        {requests.map((request) => (
          <RequestPanel
            key={request.id}
            request={request}
            sessionName={session.name}
            overlay={overlay}
          />
        ))}
      </div>
    )
  if (session.presence !== 'observed' || session.status !== 'needs-attention') return null
  const harness = harnessFor(snapshot, session.harness)
  const question = session.attention.some((item) => item.kind === 'question')
  return (
    <div className="mt-3 rounded-lg bg-attention/10 p-3 text-xs" role="status">
      <p className="font-medium text-attention">
        {question
          ? 'Question awaiting your answer'
          : session.attention.some((item) => item.kind === 'permission')
            ? 'Approval needed'
            : 'Needs your attention'}
      </p>
      <p className="mt-1 leading-5 text-muted-foreground">
        {attentionHint(session, harness, question)}
      </p>
    </div>
  )
}

function attentionHint(session: SessionRecord, harness: HarnessCatalogEntry, question: boolean) {
  const { name } = harness
  if (session.harness === 'codex') {
    if (question)
      return harness.controlsConnection === 'connected'
        ? 'Answer this question in Codex. Its question details are unavailable in Buddy.'
        : 'Answer this question in Codex. Native replies aren’t connected to this session.'
    if (harness.controls)
      return 'Answer in Codex. Buddy shows replies when connected to the same local app server.'
  }
  if (session.harness === 'claude-code' && session.parentId)
    return 'Answer in Claude Code. Subagent requests stay there so its prompt isn’t delayed.'
  if (harness.controls)
    return `The request details haven’t reached Buddy. Answer in ${name}; restart ${name} once after enabling replies.`
  return `Answer in ${name}, or enable companion replies in Integrations.`
}
