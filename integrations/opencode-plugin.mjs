import { randomUUID } from 'node:crypto'
import { report } from './reporter.mjs'

// The installer replaces this one placeholder with Buddy's private descriptor.
const configPath = '__BUDDY_BRIDGE_CONFIG__'
export default async function BuddyPlugin({ client, directory }) {
  const known = new Map()
  const active = new Set()
  const generations = new Map()
  const deleted = new Set()
  let disposed = false
  let recovering = false
  let reconcileAgain = false
  let lastStamp = 0
  const send = (event, p, extra = {}) => {
    const info = p.info
    const sessionId = p.sessionID ?? info?.id
    if (typeof sessionId !== 'string') return
    if (info)
      known.set(sessionId, {
        ...known.get(sessionId),
        cwd: info.directory ?? directory,
        parentId: info.parentID,
        ...(typeof info.title === 'string' ? { title: info.title } : {}),
      })
    if (!['session.created', 'session.updated', 'session.deleted'].includes(event))
      active.add(sessionId)
    const context = known.get(sessionId) ?? { cwd: directory }
    lastStamp = Math.max(Date.now(), lastStamp + 0.01)
    void report(configPath, {
      harness: 'opencode',
      event,
      sessionId,
      ...context,
      id: extra.id ?? randomUUID(),
      at: lastStamp,
      status: p.status?.type,
      requestId: event.endsWith('asked') ? p.id : (p.requestID ?? p.permissionID),
      ...extra,
    })
  }
  // Query this plugin's own SDK authority only. status() lists active turns;
  // list() conversations alone never establishes an open/active session.
  const reconcile = async () => {
    if (disposed) return
    if (recovering) {
      reconcileAgain = true
      return
    }
    recovering = true
    const baseline = new Map(generations)
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), 1000)
    try {
      const response = await client.session.status({ signal: controller.signal })
      const statuses = response.data
      // The supplied v1 SDK has no pending-request list methods. In verified
      // 1.18.35 its generated HTTP client is _client. Reuse that authenticated
      // authority for documented read-only endpoints. A changed SDK omits
      // request reconciliation rather than guessing a server or credentials.
      let requests
      if (typeof client._client?.get === 'function') {
        const [permissions, questions] = await Promise.all([
          client._client.get({
            url: '/permission',
            query: { directory },
            signal: controller.signal,
          }),
          client._client.get({ url: '/question', query: { directory }, signal: controller.signal }),
        ])
        if (Array.isArray(permissions.data) && Array.isArray(questions.data))
          requests = [
            ...permissions.data.map((p) => ({
              sessionId: p.sessionID,
              id: p.id,
              kind: 'permission',
            })),
            ...questions.data.map((p) => ({ sessionId: p.sessionID, id: p.id, kind: 'question' })),
          ]
      }
      if (statuses && typeof statuses === 'object') {
        const sessions = new Set([
          ...active,
          ...Object.keys(statuses),
          ...(requests ?? []).map((p) => p.sessionId),
        ])
        // A plugin may attach after session.updated. Recover title metadata
        // only for already observed/working sessions, never import disk history.
        if (typeof client.session.get === 'function')
          await Promise.all(
            [...sessions]
              .filter((id) => !known.get(id)?.title)
              .filter((id) => !deleted.has(id))
              .slice(0, 32)
              .map(async (id) => {
                try {
                  const response = await client.session.get({
                    path: { id },
                    query: { directory },
                    signal: controller.signal,
                  })
                  if (
                    !disposed &&
                    !deleted.has(id) &&
                    response.data?.id === id &&
                    !known.get(id)?.title
                  )
                    known.set(id, {
                      cwd: response.data.directory ?? directory,
                      parentId: response.data.parentID,
                      title: response.data.title,
                    })
                } catch {
                  // Unsupported or disconnected sources keep their fallback name.
                }
              }),
          )
        for (const sessionId of sessions) {
          if (disposed) break
          if (deleted.has(sessionId)) continue
          // Do not give an old API payload a new timestamp. A live event during
          // any await supersedes this session's reconciliation; fetch it again.
          if ((generations.get(sessionId) ?? 0) !== (baseline.get(sessionId) ?? 0)) {
            reconcileAgain = true
            continue
          }
          const status = statuses[sessionId] ?? { type: 'idle' }
          send(
            'buddy.reconcile',
            { sessionID: sessionId, status },
            {
              ...(requests
                ? {
                    attention: requests
                      .filter((p) => p.sessionId === sessionId)
                      .map(({ id, kind }) => ({ id, kind })),
                  }
                : {}),
            },
          )
        }
      }
    } catch {
      /* Offline or unsupported server: existing observations expire. */
    } finally {
      clearTimeout(deadline)
      recovering = false
      if (!disposed && reconcileAgain) {
        reconcileAgain = false
        void reconcile()
      }
    }
  }
  const timer = setInterval(() => void reconcile(), 30_000)
  timer.unref?.()
  void reconcile()
  const events = new Set([
    'session.created',
    'session.updated',
    'session.deleted',
    'session.status',
    'session.idle',
    'session.error',
    'permission.asked',
    'permission.replied',
    'permission.v2.asked',
    'permission.v2.replied',
    'question.asked',
    'question.replied',
    'question.rejected',
  ])
  return {
    event: async ({ event }) => {
      if (!disposed && events.has(event.type)) {
        const sessionId = event.properties?.sessionID ?? event.properties?.info?.id
        if (typeof sessionId === 'string' && event.type !== 'session.updated') {
          generations.set(sessionId, (generations.get(sessionId) ?? 0) + 1)
          if (event.type === 'session.deleted') deleted.add(sessionId)
          else deleted.delete(sessionId)
        }
        send(event.type, event.properties ?? {}, { id: event.id })
        if (event.type === 'session.deleted') {
          const id = event.properties?.sessionID ?? event.properties?.info?.id
          known.delete(id)
          active.delete(id)
        }
        if (
          [
            'permission.replied',
            'permission.v2.replied',
            'question.replied',
            'question.rejected',
          ].includes(event.type)
        )
          void reconcile()
      }
    },
    dispose: async () => {
      disposed = true
      clearInterval(timer)
    },
  }
}
