import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSource } from './load-source.mjs'
import { codexFixture } from './codex-fixture.mjs'

const { CodexAppServer, codexSocketPath, codexRequest, SessionStore, companionRecords } =
  await loadSource('tests/codex-entry.ts')
const until = async (check) => {
  const end = Date.now() + 8000
  while (Date.now() < end) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Codex fixture did not settle')
}
async function fixture(t, prepare = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'buddy codex '))
  let server
  let store
  let bridge
  t.after(async () => {
    bridge?.dispose()
    store?.dispose()
    await server?.close()
    rmSync(directory, { recursive: true, force: true })
  })
  server = await codexFixture(
    codexSocketPath({
      CODEX_HOME: join(
        directory,
        'a long relocated codex home beyond the unix socket address limit',
      ),
    }),
  )
  store = new SessionStore(join(directory, 'sessions.json'))
  bridge = new CodexAppServer({
    socketPath: () => server.socketPath,
    changed: () => {},
    observed: (event) => store.apply(event),
    resolved: (...args) => store.resolveControlAttention(...args),
  })
  const native = await server.nativeClient()
  await until(() => native.messages.some((message) => message.id === 'native-subscribe'))
  prepare(server)
  bridge.configure(true)
  await until(() => bridge.state().controlsConnection === 'connected')
  return { directory, server, store, bridge, native }
}

test('Codex paths use each user’s home and CODEX_HOME, including spaces and relocated directories', () => {
  assert.equal(
    codexSocketPath({}, '/tmp/another user'),
    '/tmp/another user/.codex/app-server-control/app-server-control.sock',
  )
  assert.equal(
    codexSocketPath({ CODEX_HOME: '/tmp/custom codex' }, '/tmp/ignored'),
    '/tmp/custom codex/app-server-control/app-server-control.sock',
  )
  assert.equal(
    codexSocketPath({ CODEX_HOME: '' }, '/tmp/third user'),
    '/tmp/third user/.codex/app-server-control/app-server-control.sock',
  )
})

test(
  'one native approval appears in both clients; a Buddy reply awaits native resolution and clears both',
  { timeout: 10_000 },
  async (t) => {
    const { server, bridge, native, store, directory } = await fixture(t)
    server.holdResolution()
    server.ask(41)
    await until(
      () => bridge.snapshot().length && native.messages.some((message) => message.id === 41),
    )
    const request = bridge.snapshot()[0]
    assert.equal(request.sessionId, 'codex:native-thread')
    assert(request.details.includes('echo native approval'))
    assert.equal(
      JSON.parse(request.details).threadId,
      undefined,
      'Approval UI omits internal routing IDs',
    )
    assert.equal(Object.keys(JSON.parse(request.details))[0], 'command', 'Command comes first')
    await bridge.respond(request.id, { decision: 'allow' })
    await until(() => server.decisions.length)
    assert.deepEqual(server.decisions[0], {
      id: 41,
      result: { decision: 'accept' },
      client: 'buddy',
    })
    assert.equal(bridge.snapshot()[0].submitting, true, 'Socket write is not an acknowledgment')
    await assert.rejects(bridge.respond(request.id, { decision: 'allow' }), /already/)
    server.broadcast('native-thread', {
      method: 'serverRequest/resolved',
      params: { threadId: 'native-thread', requestId: '41' },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(bridge.snapshot().length, 1, 'Numeric and string request IDs are distinct')
    server.resolveRequest(41)
    await until(
      () =>
        !bridge.snapshot().length &&
        native.messages.some((message) => message.method === 'serverRequest/resolved'),
    )
    assert.equal(store.get('codex:native-thread').status, 'working')
    await assert.rejects(bridge.respond(request.id, { decision: 'allow' }), /ended/)
    store.flush()
    const durable = readFileSync(join(directory, 'sessions.json'), 'utf8')
    assert(!durable.includes('echo native approval'))
    assert(!durable.includes('PRIVATE CONVERSATION'))
    const resumes = server.calls.filter(
      (call) => call.client === 'buddy' && call.method === 'thread/resume',
    )
    assert.deepEqual(
      resumes.map((call) => call.params),
      [{ threadId: 'native-thread', excludeTurns: true }],
    )
    assert(
      !server.calls.some((call) => /turn\/start|thread\/start|config\/.*write/.test(call.method)),
    )
  },
)

test(
  'answering in native Codex retires Buddy controls and rejects a stale companion click',
  { timeout: 10_000 },
  async (t) => {
    const { server, bridge, native } = await fixture(t)
    server.ask('native-first')
    await until(() => bridge.snapshot().length)
    const request = bridge.snapshot()[0]
    native.respond('native-first', { decision: 'decline' })
    await until(() => !bridge.snapshot().length)
    await assert.rejects(bridge.respond(request.id, { decision: 'allow' }), /ended/)
    assert.deepEqual(server.decisions, [
      { id: 'native-first', result: { decision: 'decline' }, client: 'native' },
    ])
  },
)

test(
  'native handoff, disconnect and disabling replies never answer or cancel the native prompt',
  { timeout: 10_000 },
  async (t) => {
    const { server, bridge, native } = await fixture(t)
    server.ask('handoff')
    await until(() => bridge.snapshot().length)
    await bridge.respond(bridge.snapshot()[0].id, { decision: 'native' })
    assert.equal(bridge.snapshot().length, 0)
    assert.equal(server.requests.size, 1)
    assert.equal(server.decisions.length, 0)
    native.respond('handoff', { decision: 'accept' })
    await until(() => !server.requests.size)
    server.ask('disconnect')
    await until(() => bridge.snapshot().length)
    server.disconnectBuddy()
    await until(() => bridge.state().controlsConnection === 'unavailable')
    assert.equal(bridge.snapshot().length, 0)
    assert.equal(server.requests.size, 1)
    await until(() => bridge.state().controlsConnection === 'connected' && bridge.snapshot().length)
    assert.equal(
      bridge.snapshot()[0].details.includes('echo native approval'),
      true,
      'Reconnect replays the live request',
    )
    bridge.configure(false)
    assert.equal(bridge.state().controlsConnection, 'disabled')
    assert.equal(server.requests.size, 1)
    native.respond('disconnect', { decision: 'accept' })
    await until(() => !server.requests.size)
    assert.equal(server.decisions.length, 2)
  },
)

test(
  'Codex questions keep original question IDs and native answers clear them; turn cancellation clears controls',
  { timeout: 10_000 },
  async (t) => {
    const { server, bridge, native, store } = await fixture(t)
    server.ask('question', 'item/tool/requestUserInput', {
      questions: [
        {
          id: 'decision_id',
          header: 'Decision',
          question: 'Continue?',
          isOther: true,
          options: [
            { label: 'Yes', description: 'Continue work' },
            { label: 'No', description: 'Stop' },
          ],
        },
      ],
    })
    await until(() => bridge.snapshot().length)
    assert.equal(bridge.snapshot()[0].kind, 'question')
    await assert.rejects(bridge.respond(bridge.snapshot()[0].id, { answers: [[]] }), /Answer each/)
    await bridge.respond(bridge.snapshot()[0].id, { answers: [['Custom answer']] })
    await until(() => !bridge.snapshot().length)
    assert.deepEqual(server.decisions[0].result, {
      answers: { decision_id: { answers: ['Custom answer'] } },
    })
    server.ask('question-native', 'item/tool/requestUserInput', {
      questions: [
        {
          id: 'q2',
          question: 'Which?',
          header: 'Choice',
          options: [{ label: 'A', description: '' }],
        },
      ],
    })
    await until(() => bridge.snapshot().length)
    native.respond('question-native', { answers: { q2: { answers: ['A'] } } })
    await until(() => !bridge.snapshot().length)
    server.ask('cancelled')
    await until(() => bridge.snapshot().length)
    server.broadcast('native-thread', {
      method: 'turn/completed',
      params: { threadId: 'native-thread', turn: { id: 'native-turn', status: 'interrupted' } },
    })
    await until(() => !bridge.snapshot().length)
    assert.equal(store.get('codex:native-thread').status, 'interrupted')
    assert.equal(server.decisions.length, 2, 'Cancellation sends no new decision')
  },
)

test(
  'unattachable loaded sessions do not break replies, and inactive or unloaded threads stay out of the companion',
  { timeout: 10_000 },
  async (t) => {
    const { server, bridge, store } = await fixture(t, (server) => {
      server.threads.set('internal', {
        id: 'internal',
        status: { type: 'idle' },
        resumeUnavailable: true,
      })
      server.threads.set('inactive', {
        id: 'inactive',
        name: 'Already idle',
        status: { type: 'idle' },
      })
      server.threads.set('unloaded', { id: 'unloaded', status: { type: 'notLoaded' } })
    })
    assert.equal(bridge.state().controlsConnection, 'connected')
    assert.equal(store.get('codex:inactive').presence, 'stale')
    assert(!store.snapshot().sessions.some((session) => session.id === 'codex:inactive'))
    assert(
      !server.calls.some(
        (call) =>
          call.client === 'buddy' &&
          call.method === 'thread/resume' &&
          call.params.threadId === 'unloaded',
      ),
    )
    server.ask('after-internal-failure')
    await until(() => bridge.snapshot().length)
    await bridge.respond(bridge.snapshot()[0].id, { decision: 'reject' })
    await until(() => !bridge.snapshot().length)
    assert.equal(server.decisions[0].result.decision, 'decline')
  },
)

test(
  'native completion stays green through idle notifications and expires from the companion; native failures stay errors',
  { timeout: 10_000 },
  async (t) => {
    const { server, store } = await fixture(t)
    server.broadcast('native-thread', {
      method: 'turn/started',
      params: { threadId: 'native-thread', turn: { id: 'completed-turn' } },
    })
    server.broadcast('native-thread', {
      method: 'turn/completed',
      params: { threadId: 'native-thread', turn: { id: 'completed-turn', status: 'completed' } },
    })
    await until(() => store.get('codex:native-thread').status === 'completed')
    const at = store.get('codex:native-thread').statusChangedAt
    server.broadcast('native-thread', {
      method: 'thread/status/changed',
      params: { threadId: 'native-thread', status: { type: 'idle' } },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(store.get('codex:native-thread').status, 'completed')
    assert.equal(store.get('codex:native-thread').statusChangedAt, at)
    assert.equal(companionRecords(store.snapshot().sessions, at + 13_000).length, 0)
    server.broadcast('native-thread', {
      method: 'turn/started',
      params: { threadId: 'native-thread', turn: { id: 'failed-turn' } },
    })
    server.broadcast('native-thread', {
      method: 'turn/completed',
      params: { threadId: 'native-thread', turn: { id: 'failed-turn', status: 'failed' } },
    })
    await until(() => store.get('codex:native-thread').status === 'error')
    server.broadcast('native-thread', {
      method: 'thread/status/changed',
      params: { threadId: 'native-thread', status: { type: 'idle' } },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(store.get('codex:native-thread').status, 'error')
  },
)

test('permissions respect native choices, full patches, turn scope and unsupported payloads', () => {
  const params = {
    threadId: 't',
    turnId: 'turn',
    itemId: 'item',
    command: 'echo test',
    additionalPermissions: { fileSystem: { write: ['/tmp/test'] } },
  }
  const limited = codexRequest(1, 'item/commandExecution/requestApproval', {
    ...params,
    availableDecisions: ['decline', 'acceptForSession'],
  })
  assert.deepEqual(limited.view.allowedDecisions, ['reject'])
  assert(limited.view.details.includes('/tmp/test'))
  assert.equal(
    codexRequest(1, 'item/fileChange/requestApproval', params),
    null,
    'No approval of an unseen patch',
  )
  const patch = codexRequest(1, 'item/fileChange/requestApproval', params, {
    type: 'fileChange',
    changes: [{ path: '/tmp/file', diff: '+new line' }],
  })
  assert(patch.view.details.includes('+new line'))
  const grant = codexRequest(1, 'item/permissions/requestApproval', {
    ...params,
    permissions: { network: { enabled: true } },
  })
  assert.deepEqual(grant.result({ decision: 'allow' }), {
    permissions: { network: { enabled: true } },
    scope: 'turn',
  })
  assert.deepEqual(grant.result({ decision: 'reject' }), { permissions: {}, scope: 'turn' })
  assert.equal(
    codexRequest(1, 'item/commandExecution/requestApproval', {
      ...params,
      command: 'x'.repeat(64_000),
    }),
    null,
  )
  assert.equal(
    codexRequest(1, 'item/tool/requestUserInput', {
      ...params,
      questions: [{ id: 'secret', question: 'Password?', isSecret: true }],
    }),
    null,
  )
  assert.equal(codexRequest(1, 'mcpServer/elicitation/request', params), null)
})
