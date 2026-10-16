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
                  : 'export const connectControls = (_path, _harness, callback, closed) => globalThis.__buddyConnectControls(callback, closed)',
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

const settle = () => new Promise((resolve) => setImmediate(resolve))
const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const form = (id = 'form-1', sessionID = 'session-1') => ({
  id,
  sessionID,
  title: 'Choose a path',
  fields: [
    {
      key: 'path',
      type: 'string',
      title: 'Path',
      required: true,
      options: [{ value: 'proceed', label: 'Proceed' }],
      custom: false,
    },
  ],
  state: { status: 'pending' },
})
const permission = (id = 'permission-1', sessionID = 'session-1') => ({
  id,
  sessionID,
  action: 'shell',
  resources: ['git status'],
})

async function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const stateHome = mkdtempSync(join(tmpdir(), 'buddy-opencode-service-'))
  mkdirSync(join(stateHome, 'opencode'))
  const registration = join(stateHome, 'opencode/service.json')
  writeFileSync(registration, JSON.stringify({ url: 'http://127.0.0.1:1', pid: process.pid }))
  const previousHome = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = stateHome
  const state = { active: {}, permissions: [], forms: [] }
  const observations = [],
    packets = [],
    replies = [],
    calls = []
  const metadata = new Map()
  const reads = new Map()
  const handlers = new Map()
  let onControl,
    disconnect,
    stream,
    subscriptions = 0,
    closed = 0
  globalThis.__buddyPluginReport = (_path, value) => observations.push(value)
  globalThis.__buddyConnectControls = (callback, onClose) => {
    onControl = callback
    disconnect = onClose
    return { send: (p) => packets.push(p), close() {} }
  }
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname
    calls.push({ path, init })
    const handler = handlers.get(path)
    let data
    if (handler) data = await handler(init)
    else if (path === '/api/session/active') data = state.active
    else if (path === '/api/permission/request') data = state.permissions
    else if (path === '/api/form') data = state.forms
    else {
      const match = path.match(/^\/api\/session\/([^/]+)\/form\/([^/]+)(\/reply)?$/)
      assert(match, `Unexpected API request ${path}`)
      const current = state.forms.find((p) => p.id === match[2] && p.sessionID === match[1])
      if (match[3]) {
        replies.push({ formID: match[2], ...JSON.parse(init.body) })
        state.forms = state.forms.filter((p) => p !== current)
        return { ok: true, status: 204 }
      }
      data = current ?? null
    }
    return { ok: true, status: 200, json: async () => ({ data }) }
  }
  const ctx = {
    location: { directory: '/projects/buddy' },
    session: {
      get: async ({ sessionID }) => {
        reads.set(sessionID, (reads.get(sessionID) ?? 0) + 1)
        return (
          metadata.get(sessionID) ?? {
            id: sessionID,
            title: 'Recovered session',
            location: ctx.location,
          }
        )
      },
    },
    permission: {
      list: async ({ sessionID }) => state.permissions.filter((p) => p.sessionID === sessionID),
      get: async ({ sessionID, requestID }) =>
        state.permissions.find((p) => p.id === requestID && p.sessionID === sessionID),
      reply: async (input) => {
        assert(['once', 'reject'].includes(input.decision))
        replies.push(input)
        state.permissions = state.permissions.filter((p) => p.id !== input.requestID)
      },
    },
    event: {
      subscribe({ signal }) {
        subscriptions++
        const queue = []
        let wake = () => {},
          end = false
        stream = {
          push(event) {
            queue.push(event)
            wake()
          },
          end() {
            end = true
            wake()
          },
        }
        signal.addEventListener('abort', () => wake(), { once: true })
        return {
          async *[Symbol.asyncIterator]() {
            try {
              while (!signal.aborted && !end) {
                if (!queue.length)
                  await new Promise((resolve) => {
                    wake = resolve
                  })
                while (queue.length && !signal.aborted) yield queue.shift()
              }
            } finally {
              closed++
            }
          },
        }
      },
    },
  }
  const plugin = await loadPlugin()
  const cleanup = plugin.setup(ctx)
  t.after(async () => {
    cleanup()
    await settle()
    globalThis.fetch = previousFetch
    delete globalThis.__buddyPluginReport
    delete globalThis.__buddyConnectControls
    if (previousHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previousHome
    rmSync(stateHome, { recursive: true, force: true })
  })
  const tick = async (ms) => {
    t.mock.timers.tick(ms)
    await settle()
  }
  const emit = async (type, data, extra = {}) => {
    stream.push({ id: crypto.randomUUID(), type, data, ...extra })
    await settle()
  }
  return {
    ctx,
    state,
    observations,
    packets,
    replies,
    calls,
    metadata,
    reads,
    handlers,
    registration,
    cleanup,
    tick,
    emit,
    control: async (p) => {
      onControl(p)
      await settle()
    },
    disconnect: () => disconnect(),
    end: async () => {
      stream.end()
      await settle()
    },
    subscriptions: () => subscriptions,
    closed: () => closed,
    reconcile: async () => {
      await tick(15000)
      await tick(100)
    },
  }
}

test('V2 subscriptions normalize native metadata, deduplicate events and stop at disposal', async (t) => {
  const f = await fixture(t)
  await f.emit('session.created', {
    sessionID: 's',
    title: 'Build Buddy',
    parentID: 'parent',
    location: f.ctx.location,
  })
  await f.emit('session.renamed', { sessionID: 's', title: 'New title' })
  const event = { id: 'duplicate' }
  await f.emit('session.tool.failed', { sessionID: 's' }, event)
  await f.emit('session.tool.failed', { sessionID: 's' }, event)
  const last = f.observations.at(-1)
  assert.equal(last.title, 'New title')
  assert.equal(last.parentId, 'parent')
  assert.equal(f.observations.filter((p) => p.id === 'duplicate').length, 1)
  f.cleanup()
  await settle()
  assert.equal(f.closed(), 1)
  const count = f.observations.length
  await f.tick(60000)
  assert.equal(f.observations.length, count)
})

test('stale active snapshots cannot overwrite completion, deletion or newer activity', async (t) => {
  for (const event of [
    'session.execution.succeeded',
    'session.deleted',
    'session.execution.started',
  ]) {
    await t.test(event, async (t) => {
      const f = await fixture(t)
      await f.emit('session.execution.started', { sessionID: 's' })
      const read = deferred()
      f.handlers.set('/api/session/active', () => read.promise)
      await f.tick(100)
      await f.emit(event, { sessionID: 's' })
      const count = f.observations.length
      read.resolve(event.endsWith('started') ? {} : { s: 'running' })
      await settle()
      assert(!f.observations.slice(count).some((p) => p.event === 'buddy.reconcile'))
    })
  }
})

test('disposal drops in-flight reconciliation and metadata results', async (t) => {
  const f = await fixture(t)
  const meta = deferred(),
    snapshot = deferred()
  f.ctx.session.get = () => meta.promise
  f.handlers.set('/api/session/active', () => snapshot.promise)
  await f.emit('session.execution.started', { sessionID: 's' })
  await f.tick(100)
  f.cleanup()
  const count = f.observations.length
  meta.resolve({ id: 's', title: 'Late', location: f.ctx.location })
  snapshot.resolve({ s: 'running' })
  await settle()
  assert.equal(f.observations.length, count)
})

test('cold activity recovers ancestor identities without making ancestors active', async (t) => {
  const f = await fixture(t)
  f.metadata.set('child', {
    id: 'child',
    title: 'Review',
    parentID: 'parent',
    location: f.ctx.location,
  })
  f.metadata.set('parent', {
    id: 'parent',
    title: 'Build',
    parentID: 'root',
    location: f.ctx.location,
  })
  f.metadata.set('root', { id: 'root', title: 'Task', location: f.ctx.location })
  await f.emit('session.step.started', { sessionID: 'child' })
  assert(
    f.observations.some(
      (p) => p.sessionId === 'child' && p.parentId === 'parent' && p.title === 'Review',
    ),
  )
  assert(f.observations.some((p) => p.sessionId === 'parent' && p.parentId === 'root'))
  assert(
    f.observations
      .filter((p) => p.sessionId === 'root')
      .every((p) => p.event === 'session.updated'),
  )
  assert.equal(f.reads.get('child'), 1)
})

test('a concurrent rename wins metadata recovery without losing recovered ancestry', async (t) => {
  const f = await fixture(t)
  const meta = deferred()
  const get = f.ctx.session.get
  f.ctx.session.get = (input) => (input.sessionID === 'child' ? meta.promise : get(input))
  await f.emit('session.step.started', { sessionID: 'child' })
  await f.emit('session.renamed', { sessionID: 'child', title: 'New name' })
  meta.resolve({ id: 'child', title: 'Old name', parentID: 'parent', location: f.ctx.location })
  await settle()
  const child = f.observations.filter((p) => p.sessionId === 'child').at(-1)
  assert.equal(child.title, 'New name')
  assert.equal(child.parentId, 'parent')
})

test('recovered active sessions become idle on an authoritative empty snapshot', async (t) => {
  const f = await fixture(t)
  f.state.active = { s: 'running' }
  await f.tick(100)
  assert(f.observations.some((p) => p.sessionId === 's' && p.status === 'busy'))
  f.state.active = {}
  await f.reconcile()
  assert.equal(f.observations.at(-1).status, 'idle')
})

test('failed or malformed active snapshots never refresh cached busy state', async (t) => {
  const f = await fixture(t)
  await f.emit('session.execution.started', { sessionID: 's' })
  f.handlers.set('/api/session/active', () => {
    throw new Error('offline')
  })
  await f.tick(100)
  f.handlers.set('/api/session/active', () => [])
  await f.reconcile()
  assert(!f.observations.some((p) => p.event === 'buddy.reconcile'))
})

test('failed request reads retain prompts while a successful empty read clears them', async (t) => {
  const f = await fixture(t)
  f.state.active = { 'session-1': 'running' }
  f.state.permissions = [permission()]
  f.state.forms = [form()]
  await f.control({ op: 'ready', enabled: true })
  await f.tick(100)
  assert.equal(f.packets.filter((p) => p.op === 'request').length, 2)
  f.handlers.set('/api/permission/request', () => {
    throw new Error('offline')
  })
  f.handlers.set('/api/form', () => {
    throw new Error('offline')
  })
  f.ctx.permission.list = async () => {
    throw new Error('offline')
  }
  await f.reconcile()
  assert(!f.packets.some((p) => p.op === 'resolved'))
  f.handlers.clear()
  f.state.permissions = []
  f.state.forms = []
  await f.reconcile()
  assert.equal(f.packets.filter((p) => p.op === 'resolved').length, 2)
  assert.deepEqual(f.observations.at(-1).attention, [])
})

test('pending forms outside active sessions recover with replies disabled and clear by formID', async (t) => {
  const f = await fixture(t)
  f.state.forms = [form()]
  await f.tick(100)
  assert(f.observations.some((p) => p.event === 'form.created' && p.requestId === 'form-1'))
  assert.equal(f.packets.filter((p) => p.op === 'request').length, 0)
  f.state.forms = []
  await f.emit('session.form.answered', { sessionID: 'session-1', formID: 'form-1' })
  assert.equal(f.observations.at(-1).requestId, 'form-1')
  await f.tick(100)
  assert(!f.observations.at(-1).attention?.length)
})

test('new request events invalidate older empty request snapshots', async (t) => {
  const f = await fixture(t)
  await f.emit('session.execution.started', { sessionID: 'session-1' })
  const read = deferred()
  f.handlers.set('/api/form', () => read.promise)
  await f.control({ op: 'ready', enabled: true })
  await f.tick(100)
  await f.emit('form.created', { form: form() })
  read.resolve([])
  await settle()
  assert(!f.packets.some((p) => p.op === 'resolved'))
})

test('permission and form replies preserve IDs and native option values', async (t) => {
  const f = await fixture(t)
  f.state.permissions = [permission()]
  f.state.forms = [form()]
  await f.control({ op: 'ready', enabled: true })
  await f.tick(100)
  await f.control({ op: 'reply', id: 'permission-1', response: { decision: 'allow' } })
  await f.control({ op: 'reply', id: 'form-1', response: { answers: [['Proceed']] } })
  assert.deepEqual(f.replies, [
    { sessionID: 'session-1', requestID: 'permission-1', decision: 'once' },
    { formID: 'form-1', answer: { path: 'proceed' } },
  ])
  assert.equal(f.packets.filter((p) => p.op === 'result' && p.ok).length, 2)
})

test('native resolution or handoff during a reply read prevents mutation and republication', async (t) => {
  const f = await fixture(t)
  f.state.forms = [form()]
  await f.control({ op: 'ready', enabled: true })
  await f.tick(100)
  const read = deferred()
  f.handlers.set('/api/session/session-1/form/form-1', () => read.promise)
  await f.control({ op: 'reply', id: 'form-1', response: { answers: [['Proceed']] } })
  await f.emit('form.replied', { sessionID: 'session-1', id: 'form-1' })
  read.resolve(form())
  await settle()
  assert.deepEqual(f.replies, [])
  f.state.forms = [form('form-2')]
  await f.emit('form.created', { form: f.state.forms[0] })
  await f.control({ op: 'reply', id: 'form-2', response: { decision: 'native' } })
  const count = f.packets.filter((p) => p.op === 'request' && p.id === 'form-2').length
  await f.emit('form.created', { form: f.state.forms[0] })
  await f.reconcile()
  assert.equal(f.packets.filter((p) => p.op === 'request' && p.id === 'form-2').length, count)
})

test('changed forms are rejected before any mutation', async (t) => {
  const f = await fixture(t)
  f.state.forms = [form()]
  await f.control({ op: 'ready', enabled: true })
  await f.tick(100)
  f.state.forms = [{ ...form(), fields: [{ ...form().fields[0], key: 'different' }] }]
  await f.control({ op: 'reply', id: 'form-1', response: { answers: [['Proceed']] } })
  assert.equal(f.replies.length, 0)
  assert(f.packets.some((p) => p.op === 'result' && p.ok === false))
})

test('reply timeout reports an uncertain mutation and never retries automatically', async (t) => {
  const f = await fixture(t)
  f.state.permissions = [permission()]
  await f.control({ op: 'ready', enabled: true })
  await f.tick(100)
  const reply = deferred()
  let count = 0
  f.ctx.permission.reply = () => {
    count++
    return reply.promise
  }
  await f.control({ op: 'reply', id: 'permission-1', response: { decision: 'allow' } })
  await f.tick(5000)
  assert(f.packets.some((p) => p.op === 'result' && !p.ok && p.uncertain === true))
  assert.equal(count, 1)
  reply.resolve()
  await settle()
  assert(!f.packets.some((p) => p.op === 'result' && p.ok))
  await f.control({ op: 'reply', id: 'permission-1', response: { decision: 'native' } })
  assert(f.packets.some((p) => p.op === 'result' && p.ok))
})

test('hung reconciliation is bounded and the next pass can recover', async (t) => {
  const f = await fixture(t)
  const pending = deferred()
  f.handlers.set('/api/session/active', () => pending.promise)
  await f.tick(100)
  await f.tick(5000)
  f.handlers.clear()
  f.state.active = { s: 'running' }
  await f.reconcile()
  assert(f.observations.some((p) => p.status === 'busy'))
  pending.resolve({ stale: 'running' })
  await settle()
  assert(!f.observations.some((p) => p.sessionId === 'stale'))
})

test('subscription loss retries with backoff, reconciles missed work and cancels on unload', async (t) => {
  const f = await fixture(t)
  await f.end()
  assert.equal(f.subscriptions(), 1)
  await f.tick(999)
  assert.equal(f.subscriptions(), 1)
  await f.tick(1)
  assert.equal(f.subscriptions(), 2)
  f.state.active = { recovered: 'running' }
  await f.tick(100)
  assert(f.observations.some((p) => p.sessionId === 'recovered' && p.status === 'busy'))
  await f.end()
  await f.tick(1999)
  assert.equal(f.subscriptions(), 2)
  f.cleanup()
  await f.tick(10000)
  assert.equal(f.subscriptions(), 2)
})

test('a different service process is never used for reads or form replies', async (t) => {
  const f = await fixture(t)
  writeFileSync(f.registration, JSON.stringify({ url: 'http://127.0.0.1:1', pid: process.pid + 1 }))
  await f.control({ op: 'ready', enabled: true })
  await f.emit('form.created', { form: form() })
  await f.tick(100)
  assert.equal(f.calls.length, 0)
  assert(!f.packets.some((p) => p.op === 'request' && p.kind === 'question'))
  assert(f.observations.some((p) => p.event === 'form.created'))
})

test('process-wide active sessions are filtered by actual location', async (t) => {
  const f = await fixture(t)
  f.state.active = { foreign: 'running', local: 'running' }
  f.metadata.set('foreign', {
    id: 'foreign',
    location: { directory: '/different' },
    title: 'Other project',
  })
  await f.tick(100)
  assert(!f.observations.some((p) => p.sessionId === 'foreign' && p.event !== 'session.updated'))
  assert(f.observations.some((p) => p.sessionId === 'local' && p.status === 'busy'))
})

test('deletion during metadata recovery cannot resurrect a session', async (t) => {
  const f = await fixture(t)
  const metadata = deferred()
  f.ctx.session.get = () => metadata.promise
  await f.emit('session.execution.started', { sessionID: 's' })
  await f.emit('session.deleted', { sessionID: 's' })
  const count = f.observations.length
  metadata.resolve({ id: 's', title: 'Deleted', location: f.ctx.location })
  await settle()
  assert.equal(f.observations.length, count)
})

test('a failed form snapshot does not block authoritative permission resolution', async (t) => {
  const f = await fixture(t)
  f.state.permissions = [permission()]
  f.state.forms = [form()]
  await f.control({ op: 'ready', enabled: true })
  await f.tick(100)
  f.state.permissions = []
  f.handlers.set('/api/form', () => {
    throw new Error('unavailable')
  })
  await f.reconcile()
  assert(f.packets.some((p) => p.op === 'resolved' && p.id === 'permission-1'))
  assert(!f.packets.some((p) => p.op === 'resolved' && p.id === 'form-1'))
  assert.equal(
    f.observations.at(-1).attention,
    undefined,
    'Partial evidence cannot replace the whole attention set',
  )
})

test('control reconnect recovers pending requests; disabled controls never mutate the agent', async (t) => {
  const f = await fixture(t)
  f.state.permissions = [permission()]
  await f.control({ op: 'ready', enabled: true })
  await f.tick(100)
  f.disconnect()
  await f.tick(15000)
  await f.control({ op: 'ready', enabled: true })
  assert.equal(f.packets.filter((p) => p.op === 'request' && p.id === 'permission-1').length, 2)
  const read = deferred()
  f.ctx.permission.get = () => read.promise
  await f.control({ op: 'reply', id: 'permission-1', response: { decision: 'allow' } })
  await f.control({ op: 'disabled' })
  read.resolve(permission())
  await settle()
  assert.equal(f.replies.length, 0)
})

test('form mutations are single-attempt and require the same service owner at send time', async (t) => {
  const f = await fixture(t)
  f.state.forms = [form()]
  await f.control({ op: 'ready', enabled: true })
  await f.tick(100)
  let attempts = 0
  f.handlers.set('/api/session/session-1/form/form-1/reply', () => {
    attempts++
    throw new Error('connection lost after submit')
  })
  await f.control({ op: 'reply', id: 'form-1', response: { answers: [['Proceed']] } })
  assert.equal(attempts, 1)
  assert(f.packets.some((p) => p.op === 'result' && !p.ok && p.uncertain === true))
  f.handlers.set('/api/session/session-1/form/form-1', () => {
    writeFileSync(
      f.registration,
      JSON.stringify({ url: 'http://127.0.0.1:1', pid: process.pid + 1 }),
    )
    return form()
  })
  await f.control({ op: 'reply', id: 'form-1', response: { answers: [['Proceed']] } })
  assert.equal(attempts, 1, 'A service replacement between read and write is not a new authority')
})

test('unsupported forms retain attention without exposing lossy companion controls', async (t) => {
  const f = await fixture(t)
  const unsupported = { ...form(), fields: [{ ...form().fields[0], hidden: true }] }
  f.state.forms = [unsupported]
  await f.control({ op: 'ready', enabled: true })
  await f.emit('form.created', { form: unsupported })
  await f.tick(100)
  assert(f.observations.some((p) => p.requestId === 'form-1' && p.event === 'form.created'))
  assert(!f.packets.some((p) => p.op === 'request' && p.id === 'form-1'))
})
