import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'

async function loadPlugin() {
  const result = await build({
    entryPoints: ['integrations/opencode-plugin.mjs'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    plugins: [
      {
        name: 'fixture-modules',
        setup(builder) {
          builder.onResolve({ filter: /^@opencode\/plugin$/ }, () => ({
            path: 'plugin-api',
            namespace: 'fixture',
          }))
          builder.onResolve({ filter: /reporter\.mjs$/ }, () => ({
            path: 'reporter',
            namespace: 'fixture',
          }))
          builder.onResolve({ filter: /control-client\.mjs$/ }, () => ({
            path: 'control-client',
            namespace: 'fixture',
          }))
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
            contents:
              args.path === 'plugin-api'
                ? 'export const Plugin = { define: (definition) => definition }'
                : args.path === 'reporter'
                  ? 'export const report = (...args) => globalThis.__buddyPluginReport(...args)'
                  : 'export const connectControls = (_path, _harness, callback) => globalThis.__buddyConnectControls(callback)',
            loader: 'js',
          }))
        },
      },
    ],
  })
  const { default: plugin } = await import(
    'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')
  )
  return plugin
}

test('OpenCode V2 plugin subscribes to V2 events and cleans up its subscription', async (t) => {
  const observations = []
  globalThis.__buddyPluginReport = (_path, value) => observations.push(value)
  globalThis.__buddyConnectControls = () => ({ send() {}, close() {} })
  t.after(() => {
    delete globalThis.__buddyPluginReport
    delete globalThis.__buddyConnectControls
  })
  const plugin = await loadPlugin()
  assert.equal(plugin.id, 'buddy.session-observer')
  let publish
  let closed = false
  const ctx = {
    location: { directory: '/projects/buddy' },
    session: {},
    permission: {},
    event: {
      subscribe({ signal }) {
        return {
          async *[Symbol.asyncIterator]() {
            const queue = []
            publish = (event) => {
              queue.push(event)
              wake()
            }
            while (!signal.aborted) {
              if (!queue.length) {
                await new Promise((resolve) => (wake = resolve))
                if (signal.aborted) break
              }
              while (queue.length) yield queue.shift()
            }
            closed = true
          },
        }
      },
    },
  }
  let wake = () => {}
  const cleanup = plugin.setup(ctx)
  await new Promise((resolve) => setImmediate(resolve))
  publish({
    id: 'event-1',
    type: 'session.status',
    properties: { sessionID: 'session-1', status: { type: 'busy' } },
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(observations[0].sessionId, 'session-1')
  assert.equal(observations[0].status, 'busy')
  assert.equal(observations[0].cwd, '/projects/buddy')
  cleanup()
  wake()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(closed, true)
})

test('OpenCode V2 permission and form replies use their live session APIs', async (t) => {
  const observations = []
  const packets = []
  let onControl
  globalThis.__buddyPluginReport = (_path, value) => observations.push(value)
  globalThis.__buddyConnectControls = (callback) => {
    onControl = callback
    return { send: (packet) => packets.push(packet), close() {} }
  }
  t.after(() => {
    delete globalThis.__buddyPluginReport
    delete globalThis.__buddyConnectControls
  })
  const plugin = await loadPlugin()
  const form = {
    id: 'form-1',
    sessionID: 'session-1',
    title: 'Choose a path',
    fields: [
      {
        key: 'path',
        type: 'string',
        title: 'Path',
        options: [{ value: 'proceed', label: 'Proceed' }],
        custom: false,
      },
    ],
    state: { status: 'pending' },
  }
  const replies = []
  const ctx = {
    location: { directory: '/projects/buddy' },
    session: {
      active: async () => ({ 'session-1': { type: 'running' } }),
      get: async ({ sessionID }) => ({
        id: sessionID,
        directory: '/projects/buddy',
        title: 'Session',
      }),
      form: {
        list: async () => [form],
        get: async () => form,
        reply: async (input) => replies.push(input),
      },
    },
    permission: {
      list: async () => [
        { id: 'permission-1', sessionID: 'session-1', action: 'shell', resources: ['git status'] },
      ],
      get: async ({ requestID, sessionID }) => ({
        id: requestID,
        sessionID,
        action: 'shell',
        resources: ['git status'],
      }),
      reply: async (input) => replies.push(input),
    },
    event: {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          await new Promise(() => {})
        },
      }),
    },
  }
  const cleanup = plugin.setup(ctx)
  t.after(cleanup)
  await new Promise((resolve) => setImmediate(resolve))
  onControl({ op: 'ready', enabled: true })
  await new Promise((resolve) => setImmediate(resolve))
  assert(packets.some((packet) => packet.op === 'request' && packet.id === 'permission-1'))
  assert(packets.some((packet) => packet.op === 'request' && packet.id === 'form-1'))
  onControl({ op: 'reply', id: 'permission-1', response: { decision: 'allow' } })
  onControl({ op: 'reply', id: 'form-1', response: { answers: [['Proceed']] } })
  await new Promise((resolve) => setImmediate(resolve))
  assert(replies.some((reply) => reply.requestID === 'permission-1' && reply.reply === 'once'))
  assert(replies.some((reply) => reply.formID === 'form-1' && reply.answer.path === 'proceed'))
  assert(packets.some((packet) => packet.op === 'result' && packet.id === 'form-1' && packet.ok))
  assert(observations.some((observation) => observation.event === 'buddy.reconcile'))
})
