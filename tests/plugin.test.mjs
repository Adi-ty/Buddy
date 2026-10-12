import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadSource } from './load-source.mjs'

async function loadPlugin(configPath) {
  const result = await build({
    entryPoints: ['integrations/opencode-plugin.mjs'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    plugins: [
      {
        name: 'observe-reports',
        setup(builder) {
          builder.onResolve({ filter: /reporter\.mjs$/ }, () => ({
            path: 'reporter',
            namespace: 'fixture',
          }))
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents: 'export const report = (...args) => globalThis.__buddyPluginReport(...args)',
            loader: 'js',
          }))
        },
      },
    ],
  })
  const { default: plugin } = await import(
    'data:text/javascript;base64,' +
      Buffer.from(
        configPath
          ? result.outputFiles[0].text.replace(
              JSON.stringify('__BUDDY_BRIDGE_CONFIG__'),
              JSON.stringify(configPath),
            )
          : result.outputFiles[0].text,
      ).toString('base64')
  )
  return plugin
}

test(
  'OpenCode plugin recovers existing live session titles through its own metadata API',
  { timeout: 10_000 },
  async (t) => {
    const observations = []
    globalThis.__buddyPluginReport = (_path, value) => observations.push(value)
    t.after(() => delete globalThis.__buddyPluginReport)
    const plugin = await loadPlugin()
    const lookups = []
    const observer = await plugin({
      directory: '/projects/buddy',
      client: {
        session: {
          status: async () => ({ data: { 'already-working': { type: 'busy' } } }),
          get: async ({ path, signal }) => {
            assert(!signal.aborted)
            lookups.push(path.id)
            return {
              data: { id: path.id, directory: '/projects/buddy', title: 'Fix session titles' },
            }
          },
        },
        _client: { get: async () => ({ data: [] }) },
      },
    })
    t.after(() => observer.dispose())
    // Let the startup read-only reconciliation finish.
    await new Promise((done) => setImmediate(done))
    assert.deepEqual(lookups, ['already-working'])
    assert.equal(observations[0].event, 'buddy.reconcile')
    assert.equal(observations[0].title, 'Fix session titles')
    assert.equal(observations[0].status, 'busy')
    await observer.event({
      event: {
        type: 'session.updated',
        properties: { info: { id: 'already-working', title: 'A new title' } },
      },
    })
    await observer.event({
      event: { type: 'session.idle', properties: { sessionID: 'already-working' } },
    })
    assert.equal(observations.at(-1).title, 'A new title')
    assert.equal(observations.at(-1).cwd, '/projects/buddy')
    assert(!observations.some((item) => 'messages' in item || 'prompt' in item))
  },
)

test(
  'OpenCode replies use the plugin’s live authenticated client and retire native answers before mutation',
  { timeout: 10_000 },
  async (t) => {
    const { RequestBridge } = await loadSource('tests/plugin-entry.ts')
    const profile = mkdtempSync(join(tmpdir(), 'buddy-plugin-replies-'))
    const bridge = new RequestBridge(
      profile,
      () => true,
      () => {},
      () => {},
      () => {},
    )
    t.after(() => {
      bridge.dispose()
      rmSync(profile, { recursive: true, force: true })
    })
    await bridge.start()
    globalThis.__buddyPluginReport = () => {}
    t.after(() => delete globalThis.__buddyPluginReport)
    const plugin = await loadPlugin(join(profile, 'bridge.json'))
    let permissions = [
      {
        id: 'permission-1',
        sessionID: 'session',
        permission: 'bash',
        patterns: ['echo fixture'],
        metadata: { command: 'echo fixture' },
      },
    ]
    let questions = []
    const posts = []
    const observer = await plugin({
      directory: '/projects/fixture',
      client: {
        session: {
          status: async () => ({ data: { session: { type: 'busy' } } }),
          get: async ({ path }) => ({ data: { id: path.id, title: 'Fixture' } }),
        },
        _client: {
          get: async ({ url, query }) => {
            assert.equal(query.directory, '/projects/fixture')
            return { data: url === '/permission' ? permissions : questions }
          },
          post: async (p) => {
            posts.push(p)
            if (p.url.startsWith('/permission/')) permissions = []
            else questions = []
            return { data: true }
          },
        },
      },
    })
    t.after(() => observer.dispose())
    const until = async (check) => {
      for (let i = 0; i < 400; i++) {
        if (check()) return
        await new Promise((done) => setTimeout(done, 10))
      }
      throw new Error('Plugin reply fixture timed out')
    }
    await until(() => bridge.snapshot().length)
    await bridge.respond(bridge.snapshot()[0].id, { decision: 'allow' })
    await until(() => posts.length === 1 && !bridge.snapshot().length)
    assert.equal(posts[0].url, '/permission/permission-1/reply')
    assert.deepEqual(posts[0].body, { reply: 'once' })
    assert.equal(posts[0].query.directory, '/projects/fixture')
    questions = [
      {
        id: 'question-1',
        sessionID: 'session',
        questions: [
          {
            question: 'Which targets?',
            multiple: true,
            options: [
              { label: 'Mac', description: '' },
              { label: 'Web', description: '' },
            ],
          },
        ],
      },
    ]
    await observer.event({ event: { type: 'question.asked', properties: questions[0] } })
    await until(() => bridge.snapshot().length)
    await bridge.respond(bridge.snapshot()[0].id, { answers: [['Mac', 'Web']] })
    await until(() => posts.length === 2 && !bridge.snapshot().length)
    assert.equal(posts[1].url, '/question/question-1/reply')
    assert.deepEqual(posts[1].body, { answers: [['Mac', 'Web']] })
    permissions = [
      { id: 'native-wins', sessionID: 'session', permission: 'bash', patterns: ['echo native'] },
    ]
    await observer.event({ event: { type: 'permission.asked', properties: permissions[0] } })
    await until(() => bridge.snapshot().length)
    const staleId = bridge.snapshot()[0].id
    permissions = [] // Already answered at the real authority, event is still in flight.
    await bridge.respond(staleId, { decision: 'allow' })
    await until(() => !bridge.snapshot().length)
    assert.equal(posts.length, 2, 'No HTTP mutation after the native answer won')
    await assert.rejects(() => bridge.respond(staleId, { decision: 'allow' }), /ended/)
  },
)

test(
  'reconciliation discards superseded payloads, timestamps sends monotonically, and queues reply recovery',
  { timeout: 10_000 },
  async (t) => {
    const observations = []
    globalThis.__buddyPluginReport = (_path, value) => observations.push(value)
    t.after(() => delete globalThis.__buddyPluginReport)
    const plugin = await loadPlugin()
    let release
    let entered
    const waiting = new Promise((resolve) => {
      release = resolve
    })
    const started = new Promise((resolve) => {
      entered = resolve
    })
    let queries = 0
    let pending = []
    const observer = await plugin({
      directory: '/projects/buddy',
      client: {
        session: {
          status: async () => {
            queries++
            return { data: { race: { type: 'busy' } } }
          },
          get: async () => {
            entered()
            await waiting
            return { data: { id: 'race', title: 'Race' } }
          },
        },
        _client: { get: async ({ url }) => ({ data: url === '/permission' ? [...pending] : [] }) },
      },
    })
    t.after(() => observer.dispose())
    await started
    pending = [{ sessionID: 'race', id: 'new-request' }]
    await observer.event({ event: { type: 'permission.asked', properties: pending[0] } })
    release()
    await new Promise((resolve) => setImmediate(resolve))
    const reconciliations = observations.filter((item) => item.event === 'buddy.reconcile')
    assert.equal(reconciliations.length, 1, 'The outdated empty request list was discarded')
    assert.deepEqual(reconciliations[0].attention, [{ id: 'new-request', kind: 'permission' }])
    assert(reconciliations[0].at > observations[0].at)
    const before = queries
    pending = []
    await observer.event({
      event: {
        type: 'permission.replied',
        properties: { sessionID: 'race', requestID: 'new-request' },
      },
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert(queries > before, 'Replies recover status immediately, without the 30-second timer')
    assert.deepEqual(observations.at(-1).attention, [])
    assert.equal(observations.at(-1).status, 'busy')
  },
)

test(
  'a deleted session cannot be resurrected by in-flight reconciliation or after disposal',
  { timeout: 10_000 },
  async (t) => {
    const observations = []
    globalThis.__buddyPluginReport = (_path, value) => observations.push(value)
    t.after(() => delete globalThis.__buddyPluginReport)
    const plugin = await loadPlugin()
    let release
    let entered
    const waiting = new Promise((resolve) => {
      release = resolve
    })
    const started = new Promise((resolve) => {
      entered = resolve
    })
    const observer = await plugin({
      directory: '/projects/buddy',
      client: {
        session: {
          status: async () => ({ data: { deleted: { type: 'busy' } } }),
          get: async () => {
            entered()
            await waiting
            return { data: { id: 'deleted', title: 'Gone' } }
          },
        },
        _client: { get: async () => ({ data: [] }) },
      },
    })
    t.after(() => observer.dispose())
    await started
    await observer.event({
      event: { type: 'session.deleted', properties: { info: { id: 'deleted' } } },
    })
    release()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(
      observations.map((item) => item.event),
      ['session.deleted'],
    )
    await observer.dispose()
    await observer.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'deleted', status: { type: 'busy' } },
      },
    })
    assert.equal(observations.length, 1)
  },
)

test(
  'cold OpenCode activity recovers titles and nested parent metadata without marking parents active',
  { timeout: 10_000 },
  async (t) => {
    const observations = []
    globalThis.__buddyPluginReport = (_path, value) => observations.push(value)
    t.after(() => delete globalThis.__buddyPluginReport)
    const plugin = await loadPlugin()
    const observer = await plugin({
      directory: '/projects/buddy',
      client: {
        session: {
          status: async () => ({ data: {} }),
          get: async ({ path }) => ({
            data: {
              id: path.id,
              title:
                path.id === 'root'
                  ? 'Fix routing with a very descriptive session title'
                  : `Investigate ${path.id}`,
              directory: '/projects/buddy',
              ...(path.id === 'child' ? { parentID: 'root' } : {}),
            },
          }),
        },
        _client: { get: async () => ({ data: [] }) },
      },
    })
    t.after(() => observer.dispose())
    await new Promise((done) => setImmediate(done))
    await observer.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'child', status: { type: 'busy' } },
      },
    })
    await new Promise((done) => setImmediate(done))
    const metadata = observations.filter((item) => item.event === 'session.updated')
    assert(
      metadata.some((item) => item.sessionId === 'root' && item.title.startsWith('Fix routing')),
    )
    assert(
      metadata.some(
        (item) =>
          item.sessionId === 'child' &&
          item.parentId === 'root' &&
          item.title === 'Investigate child',
      ),
    )
    assert(!observations.some((item) => item.sessionId === 'root' && item.status))
    await observer.event({
      event: {
        type: 'session.updated',
        properties: { info: { id: 'child', title: 'Renamed child' } },
      },
    })
    assert.equal(
      observations.at(-1).parentId,
      'root',
      'Partial title events must preserve ancestry',
    )
  },
)

test(
  'OpenCode API metadata replaces stale cached titles but preserves renames received during a fetch',
  { timeout: 10_000 },
  async (t) => {
    t.after(() => delete globalThis.__buddyPluginReport)
    for (const renameDuringFetch of [false, true]) {
      const observations = []
      globalThis.__buddyPluginReport = (_path, value) => observations.push(value)
      const plugin = await loadPlugin()
      let release
      let entered
      const waiting = new Promise((resolve) => {
        release = resolve
      })
      const started = new Promise((resolve) => {
        entered = resolve
      })
      const observer = await plugin({
        directory: '/projects/buddy',
        client: {
          session: {
            status: async () => ({ data: {} }),
            get: async ({ path }) => {
              entered()
              await waiting
              return { data: { id: path.id, title: 'Actual session title' } }
            },
          },
          _client: { get: async () => ({ data: [] }) },
        },
      })
      t.after(() => observer.dispose())
      await new Promise((done) => setImmediate(done))
      await observer.event({
        event: {
          type: 'session.created',
          properties: { info: { id: 'named', title: 'Temporary title' } },
        },
      })
      await started
      if (renameDuringFetch)
        await observer.event({
          event: {
            type: 'session.updated',
            properties: { info: { id: 'named', title: 'A newer rename' } },
          },
        })
      release()
      await new Promise((done) => setImmediate(done))
      assert.equal(
        observations.at(-1).title,
        renameDuringFetch ? 'A newer rename' : 'Actual session title',
      )
      await observer.dispose()
    }
  },
)
