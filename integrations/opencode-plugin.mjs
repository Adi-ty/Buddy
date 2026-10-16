import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { Plugin } from '@opencode/plugin'
import { connectControls } from './control-client.mjs'
import { report } from './reporter.mjs'
import { apiJson, serviceEndpoint } from './opencode-api.mjs'
import { formQuestions, formAnswer } from './opencode-forms.mjs'

const configPath = '__BUDDY_BRIDGE_CONFIG__'
const metadataEvents = new Set([
  'session.created',
  'session.updated',
  'session.renamed',
  'session.moved',
])
const workingEvents = new Set([
  'session.step.started',
  'session.step.ended',
  'session.tool.called',
  'session.tool.progress',
  'session.tool.success',
  'session.tool.error',
  'session.tool.failed',
  'session.execution.started',
  'session.retry.scheduled',
])
const terminalEvents = new Set([
  'session.idle',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
  'session.error',
])
const askEvents = new Map([
  ['permission.asked', 'permission'],
  ['permission.v2.asked', 'permission'],
  ['form.created', 'question'],
  ['session.form.created', 'question'],
])
const resolveEvents = new Set([
  'permission.replied',
  'permission.v2.replied',
  'form.replied',
  'form.cancelled',
  'session.form.answered',
  'session.form.cancelled',
])
const watched = new Set([
  ...metadataEvents,
  ...workingEvents,
  ...terminalEvents,
  ...askEvents.keys(),
  ...resolveEvents,
  'session.status',
  'session.deleted',
])
const valueOf = (response) => response?.data ?? response
const requestId = (p) => p.requestID ?? p.permissionID ?? p.formID ?? p.id
const sessionId = (p) => p.sessionID ?? p.info?.id ?? p.session?.id ?? p.id
const directoryOf = (info) => info?.location?.directory ?? info?.directory

export default Plugin.define({
  id: 'buddy.session-observer',
  setup(ctx) {
    let disposed = false
    let lastStamp = 0
    let revision = 0
    let controls
    let controlConnected = false
    let controlEnabled = false
    let recovering = false
    let reconcileAgain = false
    let reconcileTimer
    let reconnectTimer
    let retryDelay = 1000
    const lifetime = new AbortController()
    const known = new Map()
    const active = new Set()
    const recheck = new Set()
    const generations = new Map()
    const deleted = new Set()
    const seen = new Set()
    const metadataLoaded = new Map()
    const metadataPending = new Map()
    const requests = new Map()
    const published = new Map()
    const nativeRequests = new Set()
    const pendingReplies = new Set()
    const touch = (id) => generations.set(id, ++revision)
    const current = (id, before, signal) =>
      !disposed && !signal.aborted && !deleted.has(id) && (generations.get(id) ?? 0) <= before
    const controlSend = (packet) => {
      if (!disposed) controls?.send(packet)
    }

    // Race cancellation as well as passing a signal: current plugin methods
    // may ignore request options, and must not pin recovery or reply controls.
    const bounded = async (operation, timeout) => {
      const controller = new AbortController()
      const signal = AbortSignal.any([lifetime.signal, controller.signal])
      const timer = setTimeout(() => controller.abort(), timeout)
      let rejectAbort
      try {
        const cancelled = new Promise((_, reject) => {
          rejectAbort = () => reject(new Error('OpenCode operation cancelled'))
          signal.addEventListener('abort', rejectAbort, { once: true })
          if (signal.aborted) rejectAbort()
        })
        return await Promise.race([
          cancelled,
          Promise.resolve().then(() => {
            signal.throwIfAborted()
            return operation(signal)
          }),
        ])
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', rejectAbort)
      }
    }
    const remember = (id, info) => {
      known.set(id, {
        ...known.get(id),
        ...(directoryOf(info) ? { cwd: directoryOf(info) } : {}),
        ...(typeof info.parentID === 'string' && info.parentID !== id
          ? { parentId: info.parentID }
          : {}),
        ...(typeof info.title === 'string' ? { title: info.title } : {}),
      })
    }
    const send = (event, id, p = {}, extra = {}) => {
      if (disposed || deleted.has(id)) return
      lastStamp = Math.max(Date.now(), lastStamp + 0.01)
      void report(configPath, {
        harness: 'opencode',
        event,
        sessionId: id,
        cwd: ctx.location.directory,
        ...known.get(id),
        id: randomUUID(),
        at: lastStamp,
        status: p.status?.type ?? p.status,
        interrupted: event === 'session.error' && p.error?.name === 'MessageAbortedError',
        requestId: requestId(p),
        ...extra,
      })
    }
    const recoverMetadata = async (id, ancestors = new Set()) => {
      if (disposed || deleted.has(id) || ancestors.has(id) || ancestors.size >= 8) return
      ancestors.add(id)
      if (!metadataLoaded.has(id) || Date.now() - metadataLoaded.get(id) >= 30_000) {
        let pending = metadataPending.get(id)
        if (!pending && metadataPending.size < 32 && typeof ctx.session.get === 'function') {
          pending = bounded(async (signal) => {
            const before = known.get(id)
            const info = valueOf(await ctx.session.get({ sessionID: id }, { signal }))
            if (disposed || signal.aborted || deleted.has(id) || info?.id !== id) return
            // A rename/move received during this read wins, while missing fields
            // (especially ancestry) can still be recovered from the response.
            const newer = known.get(id)
            remember(id, info)
            if (newer !== before) known.set(id, { ...known.get(id), ...newer })
            metadataLoaded.set(id, Date.now())
            if (known.get(id)?.cwd === ctx.location.directory || ancestors.size > 1)
              send('session.updated', id)
          }, 1000)
            .catch(() => {})
            .finally(() => metadataPending.delete(id))
          metadataPending.set(id, pending)
        }
        await pending
      }
      if (disposed || deleted.has(id)) return
      const parent = known.get(id)?.parentId
      if (parent) await recoverMetadata(parent, ancestors)
    }
    const retire = (id) => {
      if (published.has(id)) controlSend({ op: 'resolved', id })
      published.delete(id)
      nativeRequests.delete(id)
    }
    const publishRequest = (entry) => {
      const { request, kind } = entry
      if (
        disposed ||
        !controlEnabled ||
        published.has(request.id) ||
        nativeRequests.has(request.id) ||
        deleted.has(request.sessionID)
      )
        return
      let questions
      if (kind === 'question') {
        questions = formQuestions(request)
        if (!questions) return
        try {
          serviceEndpoint()
        } catch {
          return
        }
      }
      const details =
        kind === 'permission'
          ? JSON.stringify(
              {
                permission: request.action ?? request.permission,
                resources: request.resources ?? request.patterns,
                metadata: request.metadata,
                message: request.message,
              },
              null,
              2,
            )
          : (request.title ?? 'Your agent needs an answer to continue.')
      if (typeof details !== 'string' || details.length > 64_000) return
      published.set(request.id, entry)
      controlSend({
        op: 'request',
        id: request.id,
        sessionId: request.sessionID,
        kind,
        details,
        cwd: known.get(request.sessionID)?.cwd ?? ctx.location.directory,
        tool: kind === 'permission' ? (request.action ?? request.permission ?? null) : null,
        persistent: kind === 'question',
        ...(questions ? { questions } : {}),
      })
    }
    const formPath = (id, formId) =>
      `/api/session/${encodeURIComponent(id)}/form/${encodeURIComponent(formId)}`
    const replyToRequest = async (message) => {
      const entry = published.get(message.id)
      if (!entry || pendingReplies.has(message.id)) return
      if (message.response?.decision === 'native') {
        nativeRequests.add(message.id)
        published.delete(message.id)
        controlSend({ op: 'result', id: message.id, ok: true })
        return
      }
      const { request, kind } = entry
      const id = request.sessionID
      const stillPending = (signal) =>
        !disposed &&
        !signal.aborted &&
        controlEnabled &&
        !deleted.has(id) &&
        published.get(message.id) === entry &&
        requests.has(message.id)
      pendingReplies.add(message.id)
      let dispatched = false
      try {
        await bounded(async (signal) => {
          const currentRequest =
            kind === 'permission'
              ? valueOf(
                  await ctx.permission.get({ sessionID: id, requestID: message.id }, { signal }),
                )
              : await apiJson(formPath(id, message.id), signal)
          if (!stillPending(signal)) return
          if (
            currentRequest?.id !== message.id ||
            currentRequest.sessionID !== id ||
            (kind === 'question' && currentRequest.state?.status !== 'pending')
          ) {
            resolveRequest(message.id, id, kind)
            return
          }
          if (kind === 'permission') {
            if (!['allow', 'reject'].includes(message.response?.decision))
              throw new Error('Invalid response')
            // V2.0.29 calls this input `decision`; `reply` is the emitted event field.
            dispatched = true
            await ctx.permission.reply(
              {
                sessionID: id,
                requestID: message.id,
                decision: message.response.decision === 'allow' ? 'once' : 'reject',
              },
              { signal },
            )
          } else {
            if (JSON.stringify(currentRequest.fields) !== JSON.stringify(request.fields))
              throw new Error('The form changed; answer it in OpenCode')
            const answer = formAnswer(currentRequest, message.response?.answers)
            dispatched = true
            await apiJson(`${formPath(id, message.id)}/reply`, signal, { answer })
          }
          if (!stillPending(signal)) return
          touch(id)
          controlSend({ op: 'result', id: message.id, ok: true })
          published.delete(message.id)
          resolveRequest(message.id, id, kind)
        }, 5000)
      } catch {
        if (published.get(message.id) === entry)
          controlSend({ op: 'result', id: message.id, ok: false, uncertain: dispatched })
      } finally {
        pendingReplies.delete(message.id)
        scheduleReconcile()
      }
    }
    const resolveRequest = (requestID, id, kind) => {
      requests.delete(requestID)
      recheck.add(id)
      retire(requestID)
      send(kind === 'permission' ? 'permission.replied' : 'form.replied', id, { requestID })
    }
    const connectControlChannel = () => {
      if (disposed || controlConnected) return
      controlConnected = true
      controls = connectControls(
        join(dirname(configPath), 'controls.json'),
        'opencode',
        (message) => {
          if (disposed) return
          if (message.op === 'ready') {
            const changed = controlEnabled !== (message.enabled === true)
            controlEnabled = message.enabled === true
            if (changed && controlEnabled) {
              for (const entry of requests.values()) publishRequest(entry)
              scheduleReconcile()
            }
          } else if (message.op === 'reply') void replyToRequest(message)
          else if (message.op === 'retired') published.delete(message.id)
          else if (message.op === 'disabled') {
            controlEnabled = false
            published.clear()
          }
        },
        () => {
          controlConnected = false
          controlEnabled = false
          published.clear()
        },
      )
    }

    // A failed list is unknown, not empty. Reconcile each request kind only
    // after a complete successful read, even when companion replies are off.
    const readList = async (operation) => {
      try {
        const list = valueOf(await operation())
        return Array.isArray(list) &&
          list.every((p) => typeof p?.id === 'string' && typeof p.sessionID === 'string')
          ? list
          : null
      } catch {
        return null
      }
    }
    const reconcile = async () => {
      if (disposed) return
      if (recovering) {
        reconcileAgain = true
        return
      }
      recovering = true
      const before = revision
      try {
        await bounded(async (signal) => {
          const location = encodeURIComponent(JSON.stringify({ directory: ctx.location.directory }))
          const [live, permissions, forms] = await Promise.all([
            (async () => {
              try {
                const result = valueOf(
                  typeof ctx.session.active === 'function'
                    ? await ctx.session.active(undefined, { signal })
                    : await apiJson('/api/session/active', signal),
                )
                return result && typeof result === 'object' && !Array.isArray(result)
                  ? new Set(Object.keys(result))
                  : null
              } catch {
                return null
              }
            })(),
            readList(() => apiJson(`/api/permission/request?location=${location}`, signal)),
            readList(() => apiJson(`/api/form?location=${location}`, signal)),
          ])
          if (signal.aborted || disposed) return
          const ids = new Set([
            ...active,
            ...(live ?? []),
            ...recheck,
            ...[...requests.values()].map((p) => p.request.sessionID),
            ...(permissions ?? []).map((p) => p.sessionID),
            ...(forms ?? []).map((p) => p.sessionID),
          ])
          await Promise.all([...ids].map((id) => recoverMetadata(id)))
          if (signal.aborted || disposed) return
          for (const id of ids) {
            if (!current(id, before, signal)) continue
            const hadRequests = [...requests.values()].some((p) => p.request.sessionID === id)
            // The active endpoint is process-wide. Never attribute a different
            // directory's sessions to this location-scoped plugin instance.
            if (known.get(id)?.cwd !== ctx.location.directory) continue
            let permissionList = permissions
            if (permissionList === null && typeof ctx.permission?.list === 'function')
              permissionList = await readList(() =>
                ctx.permission.list({ sessionID: id }, { signal }),
              )
            if (!current(id, before, signal)) continue
            for (const [kind, list] of [
              ['permission', permissionList],
              ['question', forms],
            ]) {
              if (list === null) continue
              const pending = list.filter((p) => p.sessionID === id)
              const pendingIds = new Set(pending.map((p) => p.id))
              for (const [requestID, entry] of requests)
                if (
                  entry.kind === kind &&
                  entry.request.sessionID === id &&
                  !pendingIds.has(requestID)
                )
                  resolveRequest(requestID, id, kind)
              for (const request of pending) {
                if (!requests.has(request.id)) {
                  requests.set(request.id, { request, kind })
                }
                send(kind === 'permission' ? 'permission.asked' : 'form.created', id, request)
                publishRequest(requests.get(request.id))
              }
            }
            if (live) {
              const wasActive = active.has(id)
              if (live.has(id)) active.add(id)
              else active.delete(id)
              if (
                live.has(id) ||
                wasActive ||
                hadRequests ||
                recheck.has(id) ||
                [...requests.values()].some((p) => p.request.sessionID === id)
              )
                send(
                  'buddy.reconcile',
                  id,
                  { status: live.has(id) ? 'busy' : 'idle' },
                  permissionList !== null && forms !== null
                    ? {
                        attention: [...requests.values()]
                          .filter((p) => p.request.sessionID === id)
                          .map((p) => ({ id: p.request.id, kind: p.kind }))
                          .slice(-32),
                      }
                    : {},
                )
              recheck.delete(id)
            }
          }
        }, 5000)
      } catch {
        /* Keep last evidence; a failed read never refreshes cached activity. */
      } finally {
        recovering = false
        if (reconcileAgain) {
          reconcileAgain = false
          scheduleReconcile()
        }
      }
    }
    function scheduleReconcile() {
      if (disposed || reconcileTimer) return
      reconcileTimer = setTimeout(() => {
        reconcileTimer = undefined
        void reconcile()
      }, 100)
      reconcileTimer.unref?.()
    }
    const onEvent = (event) => {
      if (disposed || !watched.has(event.type)) return
      if (event.location?.directory && event.location.directory !== ctx.location.directory) return
      if (typeof event.id === 'string') {
        if (seen.has(event.id)) return
        seen.add(event.id)
        if (seen.size > 512) seen.delete(seen.values().next().value)
      }
      const p = event.data ?? event.properties ?? {}
      const request = p.form ?? p
      const id = askEvents.has(event.type) ? request.sessionID : sessionId(p)
      if (typeof id !== 'string' || deleted.has(id)) return
      touch(id)
      const info = p.info ?? p.session ?? (metadataEvents.has(event.type) ? p : null)
      if (info) remember(id, info)
      if (!known.has(id)) known.set(id, { cwd: ctx.location.directory })
      if (workingEvents.has(event.type)) active.add(id)
      else if (terminalEvents.has(event.type)) active.delete(id)
      else if (event.type === 'session.status') {
        const status = p.status?.type ?? p.status
        if (['busy', 'running', 'retry'].includes(status)) active.add(id)
        else if (status === 'idle') active.delete(id)
      }
      send(event.type, id, askEvents.has(event.type) ? request : p, {
        id: event.id ?? randomUUID(),
      })
      if (event.type === 'session.deleted') {
        deleted.add(id)
        active.delete(id)
        recheck.delete(id)
        known.delete(id)
        metadataLoaded.delete(id)
        generations.delete(id)
        for (const [requestID, entry] of requests)
          if (entry.request.sessionID === id) {
            requests.delete(requestID)
            retire(requestID)
          }
        return
      }
      void recoverMetadata(id)
      const kind = askEvents.get(event.type)
      if (kind && typeof request.id === 'string') {
        const entry = { request, kind }
        requests.set(request.id, entry)
        publishRequest(entry)
      }
      if (resolveEvents.has(event.type)) {
        const requestID = requestId(p)
        requests.delete(requestID)
        retire(requestID)
        recheck.add(id)
        scheduleReconcile()
      }
    }
    const subscribe = async () => {
      const started = Date.now()
      try {
        const events = ctx.event.subscribe({ signal: lifetime.signal })
        // Start consumption before reading snapshots so in-flight events can
        // invalidate them. Do not await metadata or HTTP inside the stream.
        scheduleReconcile()
        for await (const event of events) {
          if (disposed) break
          if (event.type === 'server.connected') scheduleReconcile()
          onEvent(event)
        }
      } catch {
        /* Reopen live-only subscriptions; they do not reconnect themselves. */
      }
      if (disposed) return
      if (Date.now() - started >= 30_000) retryDelay = 1000
      reconnectTimer = setTimeout(() => void subscribe(), retryDelay)
      reconnectTimer.unref?.()
      retryDelay = Math.min(retryDelay * 2, 30_000)
    }
    const timer = setInterval(scheduleReconcile, 15_000)
    timer.unref?.()
    const controlTimer = setInterval(() => {
      connectControlChannel()
      controlSend({ op: 'ping' })
    }, 15_000)
    controlTimer.unref?.()
    connectControlChannel()
    void subscribe()
    return () => {
      if (disposed) return
      disposed = true
      clearInterval(timer)
      clearInterval(controlTimer)
      clearTimeout(reconcileTimer)
      clearTimeout(reconnectTimer)
      lifetime.abort()
      controls?.close()
      published.clear()
      requests.clear()
    }
  },
})
