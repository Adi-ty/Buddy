import { randomUUID } from 'node:crypto'
import { report } from './reporter.mjs'
import { connectControls } from './control-client.mjs'
import { dirname, join } from 'node:path'

// The installer replaces this one placeholder with Buddy's private descriptor.
const configPath = '__BUDDY_BRIDGE_CONFIG__'
export default async function BuddyPlugin({ client, directory }) {
  const known = new Map()
  const active = new Set()
  const metadataLoaded = new Map()
  const metadataPending = new Map()
  const generations = new Map()
  const deleted = new Set()
  let disposed = false
  let recovering = false
  let reconcileAgain = false
  let lastStamp = 0
  let controls
  let controlConnected = false
  let controlEnabled = false
  const publishedRequests = new Map()
  const responsePending = new Set()
  const nativeRequests = new Set()
  const publishRequest = (p, kind) => {
    if (
      !controlEnabled ||
      nativeRequests.has(p.id) ||
      typeof p.id !== 'string' ||
      typeof p.sessionID !== 'string'
    )
      return
    const details =
      kind === 'permission'
        ? JSON.stringify(
            { permission: p.permission, patterns: p.patterns, metadata: p.metadata },
            null,
            2,
          )
        : 'Your agent needs an answer to continue.'
    if (!details || details.length > 64_000) return
    const request = {
      op: 'request',
      id: p.id,
      sessionId: p.sessionID,
      kind,
      details,
      cwd: directory,
      tool: kind === 'permission' ? p.permission : null,
      ...(kind === 'question'
        ? {
            questions: (p.questions ?? []).map((q) => ({
              text: q.question,
              header: q.header ?? '',
              multiple: q.multiple === true,
              custom: q.custom !== false,
              options: (q.options ?? []).map((o) => ({
                label: o.label,
                description: o.description ?? '',
              })),
            })),
          }
        : {}),
    }
    publishedRequests.set(p.id, { sessionId: p.sessionID, kind })
    controls?.send(request)
  }
  const answerRequest = async (message) => {
    const context = publishedRequests.get(message.id)
    if (!context || responsePending.has(message.id)) return
    if (message.response?.decision === 'native') {
      nativeRequests.add(message.id)
      controls?.send({ op: 'result', id: message.id, ok: true })
      return
    }
    responsePending.add(message.id)
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), 5000)
    try {
      // Recheck at the actual live authority before a mutation. A terminal
      // answer/cancellation may have won since the user opened the notch.
      const pending = await client._client.get({
        url: `/${context.kind}`,
        query: { directory },
        signal: controller.signal,
      })
      if (
        !Array.isArray(pending.data) ||
        !pending.data.some((p) => p.id === message.id && p.sessionID === context.sessionId)
      ) {
        controls?.send({ op: 'resolved', id: message.id })
        return
      }
      const permission = context.kind === 'permission'
      const response = message.response
      const body = permission
        ? { reply: response.decision === 'allow' ? 'once' : 'reject' }
        : { answers: response.answers }
      if (
        (!permission && !Array.isArray(response.answers)) ||
        (permission && !['allow', 'reject'].includes(response.decision))
      )
        throw new Error('Invalid response')
      const result = await client._client.post({
        url: `/${context.kind}/${encodeURIComponent(message.id)}/reply`,
        query: { directory },
        body,
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      })
      if (result.error || result.data !== true) throw new Error('Reply was not acknowledged')
      controls?.send({ op: 'result', id: message.id, ok: true })
      publishedRequests.delete(message.id)
      void reconcile()
    } catch {
      controls?.send({ op: 'result', id: message.id, ok: false })
      void reconcile()
    } finally {
      clearTimeout(deadline)
      responsePending.delete(message.id)
    }
  }
  const connectControlChannel = () => {
    if (disposed || controlConnected || typeof client._client?.post !== 'function') return
    controlConnected = true
    controls = connectControls(
      join(dirname(configPath), 'controls.json'),
      'opencode',
      (message) => {
        if (disposed) return
        if (message.op === 'ready') {
          const changed = controlEnabled !== message.enabled
          controlEnabled = message.enabled === true
          if (changed && controlEnabled) void reconcile()
        } else if (message.op === 'reply') void answerRequest(message)
        else if (message.op === 'retired') publishedRequests.delete(message.id)
        else if (message.op === 'disabled') controlEnabled = false
      },
      () => {
        controlConnected = false
        controlEnabled = false
        publishedRequests.clear()
      },
    )
  }
  const send = (event, p, extra = {}) => {
    const info = p.info
    const sessionId = p.sessionID ?? info?.id
    if (typeof sessionId !== 'string') return
    if (info)
      known.set(sessionId, {
        ...known.get(sessionId),
        cwd: info.directory ?? directory,
        ...(typeof info.parentID === 'string' ? { parentId: info.parentID } : {}),
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
  // Recover names and ancestry from this plugin's SDK authority. Ancestor
  // metadata never establishes that a parent is open or taking a turn.
  const recoverMetadata = async (id, signal, publish = false, ancestors = new Set()) => {
    if (
      disposed ||
      deleted.has(id) ||
      ancestors.has(id) ||
      ancestors.size >= 8 ||
      typeof client.session.get !== 'function'
    )
      return
    ancestors.add(id)
    if (!metadataLoaded.has(id) || Date.now() - metadataLoaded.get(id) >= 30_000) {
      let pending = metadataPending.get(id)
      if (!pending) {
        if (metadataPending.size >= 32) return
        pending = (async () => {
          try {
            const before = known.get(id)
            const response = await client.session.get({
              path: { id },
              query: { directory },
              signal,
            })
            if (disposed || deleted.has(id) || response.data?.id !== id) return
            const info = response.data
            const current = known.get(id)
            known.set(id, {
              ...current,
              cwd: info.directory ?? directory,
              ...(typeof info.parentID === 'string' ? { parentId: info.parentID } : {}),
              ...(typeof info.title === 'string' ? { title: info.title } : {}),
              ...(current?.title !== before?.title ? { title: current?.title } : {}),
              ...(current?.parentId !== before?.parentId ? { parentId: current?.parentId } : {}),
              ...(current?.cwd !== before?.cwd ? { cwd: current?.cwd } : {}),
            })
            metadataLoaded.set(id, Date.now())
          } catch {
            /* Disconnected metadata keeps the honest fallback label. */
          }
        })()
        metadataPending.set(id, pending)
      }
      await pending
      if (metadataPending.get(id) === pending) metadataPending.delete(id)
    }
    if (disposed || deleted.has(id)) return
    const parent = known.get(id)?.parentId
    if (typeof parent === 'string' && parent !== id && !ancestors.has(parent))
      await recoverMetadata(parent, signal, true, ancestors)
    if (publish && metadataLoaded.has(id) && !disposed && !deleted.has(id))
      send('session.updated', { sessionID: id })
  }
  const recoverLiveMetadata = async (id) => {
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), 1000)
    try {
      await recoverMetadata(id, controller.signal, true)
    } finally {
      clearTimeout(deadline)
    }
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
        if (Array.isArray(permissions.data) && Array.isArray(questions.data)) {
          requests = [
            ...permissions.data.map((p) => ({
              sessionId: p.sessionID,
              id: p.id,
              kind: 'permission',
            })),
            ...questions.data.map((p) => ({ sessionId: p.sessionID, id: p.id, kind: 'question' })),
          ]
          if (controlEnabled) {
            const ids = new Set(requests.map((p) => p.id))
            for (const id of nativeRequests) if (!ids.has(id)) nativeRequests.delete(id)
            for (const [id, context] of publishedRequests)
              if (
                (generations.get(context.sessionId) ?? 0) !== (baseline.get(context.sessionId) ?? 0)
              )
                ids.add(id)
            for (const id of publishedRequests.keys())
              if (!ids.has(id)) {
                controls?.send({ op: 'resolved', id })
                publishedRequests.delete(id)
              }
            for (const p of permissions.data)
              if ((generations.get(p.sessionID) ?? 0) === (baseline.get(p.sessionID) ?? 0))
                publishRequest(p, 'permission')
            for (const p of questions.data)
              if ((generations.get(p.sessionID) ?? 0) === (baseline.get(p.sessionID) ?? 0))
                publishRequest(p, 'question')
          }
        }
      }
      if (statuses && typeof statuses === 'object') {
        const sessions = new Set([
          ...active,
          ...Object.keys(statuses),
          ...(requests ?? []).map((p) => p.sessionId),
        ])
        // A plugin may attach after session.updated. Recover title metadata
        // only for already observed/working sessions, never import disk history.
        await Promise.all(
          [...sessions]
            .filter((id) => !deleted.has(id))
            .slice(0, 32)
            .map((id) => recoverMetadata(id, controller.signal)),
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
  const controlTimer = setInterval(() => {
    connectControlChannel()
    controls?.send({ op: 'ping' })
  }, 15_000)
  controlTimer.unref?.()
  connectControlChannel()
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
        if (['permission.asked', 'permission.v2.asked', 'question.asked'].includes(event.type))
          publishRequest(
            event.properties ?? {},
            event.type === 'question.asked' ? 'question' : 'permission',
          )
        if (
          [
            'permission.replied',
            'permission.v2.replied',
            'question.replied',
            'question.rejected',
          ].includes(event.type)
        ) {
          const id = event.properties?.requestID ?? event.properties?.permissionID
          if (typeof id === 'string') {
            controls?.send({ op: 'resolved', id })
            publishedRequests.delete(id)
            nativeRequests.delete(id)
          }
        }
        if (event.type === 'session.deleted') {
          const id = event.properties?.sessionID ?? event.properties?.info?.id
          known.delete(id)
          active.delete(id)
          metadataLoaded.delete(id)
        }
        if (
          typeof sessionId === 'string' &&
          event.type !== 'session.deleted' &&
          !metadataLoaded.has(sessionId)
        )
          void recoverLiveMetadata(sessionId)
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
      clearInterval(controlTimer)
      controls?.close()
    },
  }
}
