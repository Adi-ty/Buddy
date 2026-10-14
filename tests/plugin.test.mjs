import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cpSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { loadInstalledOpenCodePlugin } from './opencode-host-fixture.mjs'

test('installed OpenCode plugin loads in an isolated smoke host without a global CLI or SDK', async (t) => {
  const profile = mkdtempSync(join(tmpdir(), 'buddy-plugin-host-'))
  t.after(() => rmSync(profile, { recursive: true, force: true }))
  cpSync('integrations', join(profile, 'integrations'), { recursive: true })
  const plugin = await loadInstalledOpenCodePlugin(profile)
  assert.equal(plugin.id, 'buddy.session-observer')
  assert.equal(typeof plugin.setup, 'function')
})

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
    session: {
      get: async ({ sessionID }) => ({
        id: sessionID,
        directory: '/projects/buddy',
        title: 'Recovered session',
      }),
    },
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
    type: 'session.step.started',
    data: { sessionID: 'session-1', assistantMessageID: 'message-1' },
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(observations[0].sessionId, 'session-1')
  assert.equal(observations[0].event, 'session.step.started')
  assert.equal(observations[0].cwd, '/projects/buddy')
  publish({
    id: 'event-2',
    type: 'session.execution.succeeded',
    data: { sessionID: 'session-1' },
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(observations[1].event, 'session.execution.succeeded')
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
  const previousStateHome = process.env.XDG_STATE_HOME
  const stateHome = mkdtempSync(join(tmpdir(), 'buddy-opencode-service-'))
  mkdirSync(join(stateHome, 'opencode'), { recursive: true })
  writeFileSync(
    join(stateHome, 'opencode', 'service.json'),
    JSON.stringify({ url: 'http://127.0.0.1:1', password: 'test-password' }),
  )
  process.env.XDG_STATE_HOME = stateHome
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace('http://127.0.0.1:1', '')
    if (path === '/api/session/session-1/form' && (!init.method || init.method === 'GET'))
      return { ok: true, status: 200, json: async () => ({ data: [form] }) }
    if (path === '/api/session/session-1/form/form-1' && (!init.method || init.method === 'GET'))
      return { ok: true, status: 200, json: async () => ({ data: form }) }
    if (path === '/api/session/session-1/form/form-1/reply' && init.method === 'POST') {
      replies.push({ formID: 'form-1', answer: JSON.parse(String(init.body)).answer })
      return { ok: true, status: 204, json: async () => null }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  t.after(() => {
    globalThis.fetch = previousFetch
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previousStateHome
    rmSync(stateHome, { recursive: true, force: true })
  })
  const ctx = {
    location: { directory: '/projects/buddy' },
    session: {
      active: async () => ({ 'session-1': { type: 'running' } }),
      get: async ({ sessionID }) => ({
        id: sessionID,
        directory: '/projects/buddy',
        title: 'Session',
      }),
    },
    __form: form,
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

test('OpenCode V2 form.created events publish question attention from the nested form', async (t) => {
  const observations = []
  const packets = []
  let onControl
  let publish
  let wake = () => {}
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
          },
        }
      },
    },
  }
  const cleanup = plugin.setup(ctx)
  t.after(cleanup)
  await new Promise((resolve) => setImmediate(resolve))
  onControl({ op: 'ready', enabled: true })
  publish({
    id: 'form-event-1',
    type: 'form.created',
    data: {
      form: {
        id: 'form-event-form-1',
        sessionID: 'session-1',
        title: 'Choose an option',
        fields: [
          {
            key: 'choice',
            type: 'string',
            title: 'Choice',
            options: [{ label: 'Continue', description: 'Continue the task' }],
            custom: false,
          },
        ],
      },
    },
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert(
    observations.some((item) => item.event === 'form.created' && item.sessionId === 'session-1'),
  )
  assert(
    packets.some(
      (packet) =>
        packet.op === 'request' &&
        packet.id === 'form-event-form-1' &&
        packet.kind === 'question' &&
        packet.questions?.[0]?.options?.[0]?.label === 'Continue',
    ),
  )
  cleanup()
  wake()
})
