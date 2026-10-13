import { randomUUID } from 'node:crypto'
import { Plugin } from '@opencode/plugin'
import { report } from './reporter.mjs'

// The installer replaces this placeholder with Buddy's private descriptor.
const configPath = '__BUDDY_BRIDGE_CONFIG__'
const watched = new Set([
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

export default Plugin.define({
  id: 'buddy.session-observer',
  setup(ctx) {
    let lastStamp = 0
    let disposed = false
    const known = new Map()
    const controller = new AbortController()

    const send = (type, properties = {}, eventId) => {
      const info = properties.info ?? properties.session ?? properties
      const sessionId = properties.sessionID ?? info.id
      if (typeof sessionId !== 'string') return
      if (info && typeof info === 'object') {
        known.set(sessionId, {
          cwd: info.directory ?? ctx.location.directory,
          parentId: info.parentID,
          title: info.title,
        })
      }
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
      if (type === 'session.deleted') known.delete(sessionId)
    }

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (disposed || !watched.has(event.type)) continue
          send(event.type, event.properties ?? {}, event.id)
        }
      } catch {
        // OpenCode can stop the stream during plugin unload or server restart.
      }
    })()

    return () => {
      disposed = true
      controller.abort()
    }
  },
})
