import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { Plugin } from '@opencode/plugin'
import { connectControls } from './control-client.mjs'
import { report } from './reporter.mjs'

// The installer replaces this placeholder with Buddy's private descriptor.
const configPath = '__BUDDY_BRIDGE_CONFIG__'
const watched = new Set([
  'session.created',
  'session.updated',
  'session.deleted',
  'session.status',
  'session.step.started',
  'session.step.ended',
  'session.tool.called',
  'session.tool.progress',
  'session.tool.success',
  'session.tool.error',
  'session.execution.started',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
  'session.retry.scheduled',
  'session.idle',
  'session.error',
  'permission.asked',
  'permission.replied',
  'permission.v2.asked',
  'permission.v2.replied',
  'question.asked',
  'question.replied',
  'question.rejected',
  'session.form.created',
  'session.form.answered',
  'session.form.cancelled',
])
const valueOf = (response) => response?.data ?? response

export default Plugin.define({
  id: 'buddy.session-observer',
  setup(ctx) {
    let lastStamp = 0
    let disposed = false
    let controls
    let controlConnected = false
    let controlEnabled = false
    let recovering = false
    let reconcileAgain = false
    const known = new Map()
    const active = new Set()
    const published = new Map()
    const pendingReplies = new Set()
    const nativeRequests = new Set()
    const controller = new AbortController()

    const send = (type, properties = {}, eventId) => {
      const info =
        properties.info ??
        properties.session ??
        (['session.created', 'session.updated'].includes(type) ? properties : null)
      const sessionId = properties.sessionID ?? info?.id
      if (typeof sessionId !== 'string') return
      if (info && typeof info === 'object') {
        const previous = known.get(sessionId) ?? {}
        known.set(sessionId, {
          cwd: info.directory ?? previous.cwd ?? ctx.location.directory,
          ...(typeof info.parentID === 'string' ? { parentId: info.parentID } : {}),
          ...(typeof info.title === 'string' ? { title: info.title } : {}),
        })
      }
      if (!known.has(sessionId)) known.set(sessionId, { cwd: ctx.location.directory })
      const context = known.get(sessionId) ?? { cwd: ctx.location.directory }
      lastStamp = Math.max(Date.now(), lastStamp + 0.01)
      void report(configPath, {
        harness: 'opencode',
        event: type,
        sessionId,
        ...context,
        id: eventId ?? randomUUID(),
        at: lastStamp,
        status: properties.status?.type ?? properties.status,
        interrupted: type === 'session.error' && properties.error?.name === 'MessageAbortedError',
        requestId: properties.requestID ?? properties.permissionID ?? properties.id,
      })
      if (type === 'session.deleted') {
        known.delete(sessionId)
        active.delete(sessionId)
      }
    }

    const publishRequest = (request, kind, questions = []) => {
      if (
        !controlEnabled ||
        typeof request?.id !== 'string' ||
        typeof request.sessionID !== 'string'
      )
        return
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
      if (details.length > 64_000) return
      const requestId = request.id
      published.set(requestId, {
        sessionId: request.sessionID,
        kind,
        questions,
        formId: kind === 'question' ? request.id : null,
      })
      controls?.send({
        op: 'request',
        id: requestId,
        sessionId: request.sessionID,
        kind,
        details,
        cwd: known.get(request.sessionID)?.cwd ?? ctx.location.directory,
        tool: kind === 'permission' ? (request.action ?? request.permission ?? null) : null,
        ...(kind === 'question' ? { questions } : {}),
      })
    }

    const listForms = async (sessionID) => {
      if (typeof ctx.session.form?.list === 'function')
        return valueOf(await ctx.session.form.list({ sessionID }))
      if (typeof ctx.form?.list === 'function')
        return valueOf(await ctx.form.list({ location: { directory: ctx.location.directory } }))
      return []
    }
    const replyToRequest = async (message) => {
      const context = published.get(message.id)
      if (!context || pendingReplies.has(message.id)) return
      const response = message.response ?? {}
      if (response.decision === 'native') {
        nativeRequests.add(message.id)
        controls?.send({ op: 'result', id: message.id, ok: true })
        return
      }
      pendingReplies.add(message.id)
      try {
        if (context.kind === 'permission') {
          const current = valueOf(
            await ctx.permission.get({ sessionID: context.sessionId, requestID: message.id }),
          )
          if (current?.id !== message.id || current.sessionID !== context.sessionId) {
            controls?.send({ op: 'resolved', id: message.id })
            published.delete(message.id)
            return
          }
          if (!['allow', 'reject'].includes(response.decision)) throw new Error('Invalid response')
          await ctx.permission.reply({
            sessionID: context.sessionId,
            requestID: message.id,
            reply: response.decision === 'allow' ? 'once' : 'reject',
          })
        } else {
          if (
            !Array.isArray(response.answers) ||
            typeof ctx.session.form?.get !== 'function' ||
            typeof ctx.session.form?.reply !== 'function'
          )
            throw new Error('Form replies are unavailable')
          const current = valueOf(
            await ctx.session.form.get({ sessionID: context.sessionId, formID: context.formId }),
          )
          if (
            current?.id !== context.formId ||
            current.sessionID !== context.sessionId ||
            current.state?.status !== 'pending'
          ) {
            controls?.send({ op: 'resolved', id: message.id })
            published.delete(message.id)
            return
          }
          const answer = {}
          for (let index = 0; index < context.questions.length; index++) {
            const field = current.fields?.[index]
            const values = response.answers[index]
            if (!field || typeof field.key !== 'string' || !Array.isArray(values))
              throw new Error('Invalid form answer')
            const convert = (selected) => {
              if (field.type === 'boolean') return selected === 'Yes'
              const option = field.options?.find((candidate) => candidate.label === selected)
              return option?.value ?? selected
            }
            const selected = values.map(convert)
            if (field.type === 'multiselect') answer[field.key] = selected
            else if (field.type === 'boolean') answer[field.key] = selected[0] === true
            else if (field.type === 'integer' || field.type === 'number') {
              const parsed = Number(selected[0])
              if (
                !Number.isFinite(parsed) ||
                (field.type === 'integer' && !Number.isInteger(parsed))
              )
                throw new Error('Invalid numeric form answer')
              answer[field.key] = parsed
            } else answer[field.key] = selected[0] ?? ''
          }
          await ctx.session.form.reply({
            sessionID: context.sessionId,
            formID: context.formId,
            answer,
          })
        }
        controls?.send({ op: 'result', id: message.id, ok: true })
        published.delete(message.id)
        void reconcile()
      } catch {
        controls?.send({ op: 'result', id: message.id, ok: false })
        void reconcile()
      } finally {
        pendingReplies.delete(message.id)
      }
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
            if (changed && controlEnabled) void reconcile()
          } else if (message.op === 'reply') void replyToRequest(message)
          else if (message.op === 'retired') published.delete(message.id)
          else if (message.op === 'disabled') controlEnabled = false
        },
        () => {
          controlConnected = false
          controlEnabled = false
          published.clear()
        },
      )
    }

    const formQuestions = (form) => {
      if (!Array.isArray(form.fields) || form.fields.length > 16) return null
      const questions = []
      for (const field of form.fields) {
        if (
          !field ||
          !['string', 'multiselect', 'boolean', 'integer', 'number'].includes(field.type)
        )
          return null
        const options =
          field.type === 'boolean'
            ? [
                { label: 'Yes', description: '' },
                { label: 'No', description: '' },
              ]
            : Array.isArray(field.options)
              ? field.options.map((option) => ({
                  label: option.label,
                  description: option.description ?? '',
                }))
              : []
        const custom = field.type === 'boolean' ? false : field.custom !== false
        questions.push({
          text: field.description ?? field.title ?? form.title ?? 'Please provide an answer.',
          header: field.title ?? '',
          multiple: field.type === 'multiselect',
          custom,
          options,
        })
      }
      return questions
    }

    const reconcile = async () => {
      if (disposed) return
      if (recovering) {
        reconcileAgain = true
        return
      }
      recovering = true
      try {
        let live = new Set(active)
        if (typeof ctx.session.active === 'function') {
          try {
            const activeResponse = valueOf(await ctx.session.active())
            const statuses =
              activeResponse && typeof activeResponse === 'object' ? activeResponse : {}
            live = new Set(Object.keys(statuses))
          } catch {
            // Some V2 plugin contexts omit the active-session endpoint.
          }
        }
        for (const id of live) {
          if (!known.has(id) && typeof ctx.session.get === 'function') {
            try {
              const info = valueOf(await ctx.session.get({ sessionID: id }))
              if (info?.id === id)
                known.set(id, {
                  cwd: info.directory ?? ctx.location.directory,
                  parentId: info.parentID,
                  title: info.title,
                })
            } catch {
              /* Metadata may disappear while a session exits. */
            }
          }
          send('buddy.reconcile', { sessionID: id, status: { type: 'busy' } })
        }
        for (const id of active)
          if (!live.has(id)) {
            send('buddy.reconcile', { sessionID: id, status: { type: 'idle' } })
            active.delete(id)
          }

        if (controlEnabled) {
          const requests = []
          for (const sessionID of live) {
            try {
              const permissions = valueOf(await ctx.permission.list({ sessionID }))
              if (Array.isArray(permissions))
                requests.push(...permissions.map((request) => ({ request, kind: 'permission' })))
            } catch {
              /* Keep event-driven tracking available if request APIs differ. */
            }
            try {
              const forms = await listForms(sessionID)
              if (Array.isArray(forms))
                for (const form of forms) {
                  const questions = formQuestions(form)
                  if (questions) requests.push({ request: form, kind: 'question', questions })
                }
            } catch {
              /* Form support is optional for sessions without forms. */
            }
          }
          const ids = new Set(requests.map(({ request }) => request.id))
          for (const id of nativeRequests) if (!ids.has(id)) nativeRequests.delete(id)
          for (const id of published.keys())
            if (!ids.has(id)) {
              controls?.send({ op: 'resolved', id })
              published.delete(id)
            }
          for (const { request, kind, questions } of requests)
            if (!nativeRequests.has(request.id)) publishRequest(request, kind, questions)
        }
      } catch {
        // OpenCode can restart or disconnect; live events resume reconciliation.
      } finally {
        recovering = false
        if (!disposed && reconcileAgain) {
          reconcileAgain = false
          void reconcile()
        }
      }
    }

    const timer = setInterval(() => void reconcile(), 15_000)
    timer.unref?.()
    const controlTimer = setInterval(() => {
      connectControlChannel()
      controls?.send({ op: 'ping' })
    }, 15_000)
    controlTimer.unref?.()
    connectControlChannel()
    void reconcile()

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (disposed || !watched.has(event.type)) continue
          const properties = event.properties ?? event.data ?? {}
          const sessionId = properties.sessionID ?? properties.info?.id
          if (typeof sessionId === 'string') {
            if (
              [
                'session.step.started',
                'session.step.ended',
                'session.tool.called',
                'session.tool.progress',
                'session.tool.success',
                'session.tool.error',
                'session.execution.started',
                'session.retry.scheduled',
              ].includes(event.type)
            )
              active.add(sessionId)
            else if (event.type === 'session.status') {
              const status = properties.status?.type ?? properties.status
              if (['busy', 'running', 'retry'].includes(status)) active.add(sessionId)
              else if (status === 'idle') active.delete(sessionId)
            } else if (
              [
                'session.idle',
                'session.deleted',
                'session.execution.succeeded',
                'session.execution.failed',
                'session.execution.interrupted',
              ].includes(event.type)
            )
              active.delete(sessionId)
          }
          send(event.type, properties, event.id)
          if (['permission.asked', 'permission.v2.asked'].includes(event.type))
            publishRequest(properties, 'permission')
          else if (event.type === 'question.asked')
            publishRequest(properties, 'question', properties.questions ?? [])
          else if (event.type === 'session.form.created') {
            const questions = formQuestions(properties)
            if (questions) publishRequest(properties, 'question', questions)
          }
          if (
            [
              'permission.replied',
              'permission.v2.replied',
              'question.replied',
              'question.rejected',
              'session.form.answered',
              'session.form.cancelled',
            ].includes(event.type)
          ) {
            const id =
              properties.requestID ?? properties.permissionID ?? properties.formID ?? properties.id
            if (typeof id === 'string') {
              controls?.send({ op: 'resolved', id })
              published.delete(id)
              nativeRequests.delete(id)
            }
            void reconcile()
          }
          if (event.type === 'session.deleted')
            active.delete(properties.sessionID ?? properties.info?.id)
        }
      } catch {
        // OpenCode can stop the stream during plugin unload or server restart.
      }
    })()

    return () => {
      disposed = true
      clearInterval(timer)
      clearInterval(controlTimer)
      controller.abort()
      controls?.close()
    }
  },
})
