import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSource } from './load-source.mjs'

const { CodexAppServer, SessionStore, companionRecords, sessionFamilies } =
  await loadSource('tests/codex-entry.ts')

// Exercise the state machine without the Unix socket transport, which is
// independently covered by codex.test.mjs on hosts that permit listen().
function fixture(t, attached = true) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 })
  const directory = mkdtempSync(join(tmpdir(), 'buddy-codex-state-'))
  const store = new SessionStore(join(directory, 'sessions.json'))
  const decisions = []
  const bridge = new CodexAppServer({
    changed() {},
    observed: (event) => store.apply(event),
    resolved: (...args) => store.resolveControlAttention(...args),
  })
  bridge.enabled = true
  bridge.client = {
    connected: true,
    respond: (...args) => decisions.push(args),
    close() {},
    call: async () => ({ data: ['thread'], nextCursor: null }),
  }
  if (attached) {
    bridge.subscribing.add('thread')
    bridge.metadata({ id: 'thread', name: 'Build app', status: { type: 'active' } })
    bridge.subscribing.delete('thread')
  }
  const receive = (method, params = {}) =>
    bridge.receive({ method, params: { threadId: 'thread', ...params } })
  t.after(() => {
    bridge.dispose()
    store.dispose()
    rmSync(directory, { recursive: true, force: true })
  })
  return { bridge, store, decisions, receive }
}

test(
  'Codex ack timeout prevents duplicate decisions, permits native handoff, and accepts late resolution',
  { timeout: 10_000 },
  async (t) => {
    const { bridge, decisions } = fixture(t)
    bridge.receive({
      id: 42,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread', turnId: 'turn', itemId: 'item', command: 'echo test' },
    })
    const id = bridge.snapshot()[0].id
    await bridge.respond(id, { decision: 'allow' })
    assert.equal(bridge.snapshot()[0].submitting, true)
    t.mock.timers.tick(8001)
    assert.equal(bridge.snapshot()[0].submitting, true)
    assert.match(bridge.snapshot()[0].error, /hasn’t confirmed/)
    await assert.rejects(bridge.respond(id, { decision: 'allow' }), /already/)
    assert.equal(decisions.length, 1)
    t.mock.timers.tick(8001)
    await bridge.respond(id, { decision: 'native' })
    assert.equal(bridge.snapshot().length, 0)
    assert.equal(decisions.length, 1, 'Handoff never sends another decision')
    bridge.receive({
      method: 'serverRequest/resolved',
      params: { threadId: 'thread', requestId: 42 },
    })
    assert.equal(bridge.owns(id), false)
  },
)

test(
  'finished Codex heartbeats do not renew completion notices or resurrect a session after sleep',
  { timeout: 10_000 },
  async (t) => {
    const { bridge, store, receive } = fixture(t)
    receive('turn/started', { turn: { id: 'turn' } })
    receive('turn/completed', { turn: { id: 'turn', status: 'completed' } })
    const completedAt = store.get('codex:thread').statusChangedAt
    t.mock.timers.tick(65_000)
    await bridge.poll()
    assert.equal(store.get('codex:thread').status, 'completed')
    assert.equal(store.get('codex:thread').statusChangedAt, completedAt)
    assert.equal(companionRecords(store.snapshot().sessions).length, 0)
    store.expire(Date.now(), true)
    assert.equal(store.get('codex:thread').presence, 'stale')
    t.mock.timers.tick(65_000)
    await bridge.poll()
    assert.equal(store.snapshot().sessions.length, 0)
    receive('thread/status/changed', { status: { type: 'idle' } })
    assert.equal(
      store.snapshot().sessions.length,
      0,
      'An idle runtime must not replay its old finish',
    )
    receive('turn/started', { turn: { id: 'new-turn' } })
    assert.equal(store.get('codex:thread').status, 'working')
    assert.equal(store.get('codex:thread').presence, 'observed')
  },
)

test(
  'a stale Codex resume response cannot overwrite a completion or a live title',
  { timeout: 10_000 },
  async (t) => {
    const { bridge, store, receive } = fixture(t, false)
    let completeResume
    let resumeStarted
    const started = new Promise((resolve) => {
      resumeStarted = resolve
    })
    const old = { id: 'thread', name: 'Old title', status: { type: 'active' } }
    bridge.client.call = async (method) => {
      if (method === 'thread/loaded/list') return { data: ['thread'] }
      if (method === 'thread/read') return { thread: old }
      resumeStarted()
      return new Promise((resolve) => {
        completeResume = resolve
      })
    }
    const polling = bridge.poll()
    await started
    receive('turn/started', { turn: { id: 'turn' } })
    receive('thread/name/updated', { threadName: 'Live title' })
    receive('turn/completed', { turn: { id: 'turn', status: 'completed' } })
    const at = store.get('codex:thread').statusChangedAt
    completeResume({ thread: old })
    await polling
    assert.equal(store.get('codex:thread').name, 'Live title')
    assert.equal(store.get('codex:thread').status, 'completed')
    assert.equal(store.get('codex:thread').statusChangedAt, at)
  },
)

test(
  'late Codex read results from a lost connection cannot restore sessions',
  { timeout: 10_000 },
  async (t) => {
    const { bridge, store } = fixture(t, false)
    let completeRead
    let readStarted
    const started = new Promise((resolve) => {
      readStarted = resolve
    })
    bridge.client.call = async (method) => {
      if (method === 'thread/loaded/list') return { data: ['thread'] }
      readStarted()
      return new Promise((resolve) => {
        completeRead = resolve
      })
    }
    const polling = bridge.poll()
    await started
    bridge.lost()
    completeRead({ thread: { id: 'thread', status: { type: 'active' } } })
    await polling
    assert.equal(store.get('codex:thread'), null)
  },
)

test(
  'a thread closed during Codex resume cannot be reopened by its stale response',
  { timeout: 10_000 },
  async (t) => {
    const { bridge, store, receive } = fixture(t, false)
    let completeResume
    let resumeStarted
    const started = new Promise((resolve) => {
      resumeStarted = resolve
    })
    const old = { id: 'thread', status: { type: 'active' } }
    bridge.client.call = async (method) => {
      if (method === 'thread/loaded/list') return { data: ['thread'] }
      if (method === 'thread/read') return { thread: old }
      resumeStarted()
      return new Promise((resolve) => {
        completeResume = resolve
      })
    }
    const polling = bridge.poll()
    await started
    receive('thread/closed')
    completeResume({ thread: old })
    await polling
    assert.equal(store.get('codex:thread').presence, 'closed')
    assert.equal(store.snapshot().sessions.length, 0)
  },
)

test('native Codex failed child turns retain their outcome without turning a working parent red', (t) => {
  const { bridge, store } = fixture(t)
  bridge.subscribing.add('child')
  bridge.metadata({ id: 'child', parentThreadId: 'thread', status: { type: 'active' } })
  bridge.subscribing.delete('child')
  bridge.receive({
    method: 'turn/started',
    params: { threadId: 'child', turn: { id: 'child-turn' } },
  })
  bridge.receive({
    method: 'turn/completed',
    params: { threadId: 'child', turn: { id: 'child-turn', status: 'failed' } },
  })
  assert.equal(store.get('codex:child').status, 'error')
  assert.equal(store.get('codex:child').turnActive, false)
  assert.equal(sessionFamilies(store.snapshot().sessions)[0].summary.status, 'working')
  assert.equal(companionRecords(store.snapshot().sessions).length, 1)
  bridge.receive({
    id: 99,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'child',
      turnId: 'new-turn',
      itemId: 'command',
      command: 'echo test',
    },
  })
  assert.equal(sessionFamilies(store.snapshot().sessions)[0].summary.status, 'needs-attention')
})
