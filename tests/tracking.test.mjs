import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSource } from './load-source.mjs'
import { EventEmitter } from 'node:events'

const {
  SessionStore,
  SessionNames,
  normalizeObservation,
  prioritizeSessions,
  IntegrationManager,
  notchSignal,
  sessionNotification,
  COMPLETION_NOTICE_MS,
  sessionFamilies,
  relativeTime,
  TitleStorage,
  notchRecords,
  observeWake,
} = await loadSource('tests/tracking-entry.ts')
const event = (name, sessionId, extra = {}) =>
  normalizeObservation({
    version: 1,
    id: crypto.randomUUID(),
    at: Date.now(),
    harness: 'codex',
    event: name,
    sessionId,
    cwd: '/projects/buddy',
    ...extra,
  })

test('old failed subagents remain inspectable without keeping a later family turn red across harnesses', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'buddy-error-scope-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = new SessionStore(join(directory, 'sessions.json'))
  let at = Date.now() - 1000
  for (const harness of ['codex', 'claude-code', 'opencode']) {
    const emit = (name, id, extra = {}) =>
      store.apply(event(name, id, { harness, at: ++at, ...extra }))
    const start = (id, extra = {}) =>
      emit(harness === 'opencode' ? 'session.status' : 'UserPromptSubmit', id, {
        status: 'busy',
        ...extra,
      })
    const stop = (id) => emit(harness === 'opencode' ? 'session.idle' : 'Stop', id)
    start('parent')
    start('child', { parentId: 'parent' })
    if (harness !== 'codex')
      emit(harness === 'opencode' ? 'session.error' : 'PostToolUseFailure', 'child')
    if (harness === 'codex') {
      // Codex has no StopFailure hook; its app-server reports the failure.
      store.apply({
        ...event('PostCompact', 'child', { harness, at: ++at }),
        source: 'app-server',
        status: 'error',
      })
    }
    let records = store.snapshot().sessions.filter((item) => item.harness === harness)
    assert.equal(sessionFamilies(records)[0].summary.status, 'error')
    stop('parent')
    start('parent')
    const begun = store.get(`${harness}:parent`).turnStartedAt
    records = store.snapshot().sessions.filter((item) => item.harness === harness)
    assert.equal(sessionFamilies(records)[0].summary.status, 'working')
    assert.equal(sessionFamilies(records)[0].descendants[0].status, 'error')
    assert.equal(notchRecords(records).length, 1)
    // Ordinary tool events/heartbeats must not advance the turn boundary.
    emit(harness === 'opencode' ? 'buddy.reconcile' : 'PreToolUse', 'parent', { status: 'busy' })
    assert.equal(store.get(`${harness}:parent`).turnStartedAt, begun)
    stop('parent')
    records = store.snapshot().sessions.filter((item) => item.harness === harness)
    assert.equal(notchRecords(records, at + COMPLETION_NOTICE_MS + 1).length, 0)
    // A fresh failed child still surfaces in this turn.
    start('parent')
    start('child')
    if (harness === 'codex')
      store.apply({
        ...event('PostCompact', 'child', { harness, at: ++at }),
        source: 'app-server',
        status: 'error',
      })
    else emit(harness === 'opencode' ? 'session.error' : 'PostToolUseFailure', 'child')
    records = store.snapshot().sessions.filter((item) => item.harness === harness)
    assert.equal(sessionFamilies(records)[0].summary.status, 'error')
  }
})

test('settled failed children do not keep a continuing parent red and pending child input still surfaces for every harness', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'buddy-settled-child-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = new SessionStore(join(directory, 'sessions.json'))
  let at = Date.now() - 1000
  for (const harness of ['codex', 'claude-code', 'opencode']) {
    const emit = (name, id, extra = {}) =>
      store.apply(event(name, id, { harness, at: ++at, ...extra }))
    const rows = () => store.snapshot().sessions.filter((item) => item.harness === harness)
    if (harness === 'opencode') {
      emit('session.status', 'parent', { status: 'busy' })
      emit('session.status', 'child', { parentId: 'parent', status: 'busy' })
      emit('session.error', 'child')
      assert.equal(sessionFamilies(rows())[0].summary.status, 'error')
      emit('session.status', 'child', { status: 'idle' })
      emit('session.idle', 'child')
    } else {
      emit('UserPromptSubmit', 'parent')
      emit('SubagentStart', 'parent', { agentId: 'child' })
      if (harness === 'claude-code') emit('PostToolUseFailure', 'parent', { agentId: 'child' })
      else
        store.apply({
          ...event('PostCompact', 'child', { harness, at: ++at }),
          source: 'app-server',
          status: 'error',
          turnActive: false,
        })
      emit('SubagentStop', 'parent', { agentId: 'child' })
    }
    const startedAt = store.get(`${harness}:parent`).turnStartedAt
    const failed = store.get(`${harness}:child`)
    assert.equal(failed.status, 'error', 'A stop signal must not turn a known failure into success')
    assert.equal(failed.turnActive, false)
    assert.equal(sessionFamilies(rows())[0].summary.status, 'working')
    assert.equal(notchRecords(rows()).length, 1)
    emit(harness === 'opencode' ? 'session.status' : 'PreToolUse', 'parent', { status: 'busy' })
    assert.equal(
      store.get(`${harness}:parent`).turnStartedAt,
      startedAt,
      'Parent is continuing the same turn',
    )
    emit(harness === 'opencode' ? 'session.idle' : 'Stop', 'parent')
    assert.equal(sessionFamilies(rows())[0].summary.status, 'completed')
    assert.equal(notchRecords(rows(), at + COMPLETION_NOTICE_MS + 1).length, 0)
    // Even an older, idle child must become actionable when a new request arrives.
    if (harness === 'opencode') emit('question.asked', 'child', { requestId: 'answer' })
    else if (harness === 'claude-code')
      emit('PermissionRequest', 'parent', { agentId: 'child', requestId: 'answer' })
    else emit('PermissionRequest', 'child', { requestId: 'answer' })
    assert.equal(sessionFamilies(rows())[0].summary.status, 'needs-attention')
    assert.equal(notchRecords(rows(), at + COMPLETION_NOTICE_MS + 1)[0].id, `${harness}:child`)
  }
})

test('OpenCode busy/retry recovers an error and repeated idle reconciliation does not replay completion', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'buddy-recovery-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = new SessionStore(join(directory, 'sessions.json'))
  let at = Date.now() - 1000
  const emit = (name, status) =>
    store.apply(event(name, 'opencode', { harness: 'opencode', at: ++at, status }))
  emit('session.status', 'busy')
  emit('session.error')
  emit('session.status', 'idle')
  emit('session.idle')
  emit('buddy.reconcile', 'idle')
  assert.equal(store.get('opencode:opencode').status, 'error', 'Idle alone cannot claim success')
  emit('session.status', 'busy')
  assert.equal(store.get('opencode:opencode').status, 'working')
  emit('session.status', 'retry')
  emit('session.status', 'idle')
  emit('session.idle')
  const completedAt = store.get('opencode:opencode').statusChangedAt
  for (let i = 0; i < 3; i++) emit('buddy.reconcile', 'idle')
  assert.equal(store.get('opencode:opencode').statusChangedAt, completedAt)
  assert.equal(
    notchRecords(store.snapshot().sessions, completedAt + COMPLETION_NOTICE_MS + 1).length,
    0,
  )
})

test('OpenCode interruption survives idle reconciliation until new work starts', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'buddy-interrupted-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = new SessionStore(join(directory, 'sessions.json'))
  let at = Date.now() - 1000
  const emit = (name, extra = {}) =>
    store.apply(event(name, 'aborted', { harness: 'opencode', at: ++at, ...extra }))
  emit('session.status', { status: 'busy' })
  emit('question.asked', { requestId: 'pending' })
  emit('session.error', { interrupted: true })
  assert.equal(store.get('opencode:aborted').status, 'interrupted')
  assert.equal(store.get('opencode:aborted').attention.length, 0)
  const interruptedAt = store.get('opencode:aborted').statusChangedAt
  emit('session.status', { status: 'idle' })
  emit('session.idle')
  emit('buddy.reconcile', { status: 'idle' })
  assert.equal(store.get('opencode:aborted').status, 'interrupted')
  assert.equal(store.get('opencode:aborted').statusChangedAt, interruptedAt)
  assert.equal(store.get('opencode:aborted').turnActive, false)
  emit('session.status', { status: 'busy' })
  assert.equal(store.get('opencode:aborted').status, 'working')
})

test('title metadata can arrive before older semantic activity without dropping that activity or overwriting the title', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'buddy-metadata-order-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = new SessionStore(join(directory, 'sessions.json'))
  const at = Date.now() - 1000
  const metadata = event('session.updated', 'session', {
    harness: 'opencode',
    at: at + 20,
    title: 'New title',
    cwd: '/new/project',
  })
  const busy = event('session.status', 'session', {
    harness: 'opencode',
    at: at + 10,
    title: 'Old title',
    cwd: '/old/project',
    status: 'busy',
  })
  store.apply(metadata)
  assert.equal(store.get('opencode:session').presence, 'stale')
  assert.equal(store.apply(busy), true)
  assert.equal(store.get('opencode:session').status, 'working')
  assert.equal(store.get('opencode:session').name, 'New title')
  assert.equal(store.get('opencode:session').cwd, '/new/project')
  assert.equal(store.apply(busy), false, 'Duplicate activity is still rejected')
  store.apply(event('session.error', 'session', { harness: 'opencode', at: at + 30 }))
  assert.equal(
    store.apply(
      event('session.status', 'session', { harness: 'opencode', at: at + 25, status: 'busy' }),
    ),
    false,
  )
  assert.equal(
    store.get('opencode:session').status,
    'error',
    'Older semantic state is still rejected',
  )
  store.flush()
  assert.equal(
    new SessionStore(join(directory, 'sessions.json')).get('opencode:session').presence,
    'stale',
  )
})

test('a fresh failure after a settled child error is surfaced again instead of retaining an old idle marker', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'buddy-repeat-failure-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = new SessionStore(join(directory, 'sessions.json'))
  let at = Date.now() - 1000
  const emit = (name, id, extra = {}) =>
    store.apply(event(name, id, { harness: 'opencode', at: ++at, ...extra }))
  emit('session.status', 'parent', { status: 'busy' })
  emit('session.status', 'child', { parentId: 'parent', status: 'busy' })
  emit('session.error', 'child')
  emit('session.idle', 'child')
  const oldErrorAt = store.get('opencode:child').statusChangedAt
  assert.equal(sessionFamilies(store.snapshot().sessions)[0].summary.status, 'working')
  emit('session.error', 'child')
  assert(store.get('opencode:child').statusChangedAt > oldErrorAt)
  assert.equal(
    store.get('opencode:child').turnActive,
    undefined,
    'Activity is unknown until confirmed',
  )
  assert.equal(sessionFamilies(store.snapshot().sessions)[0].summary.status, 'error')
  emit('session.status', 'child', { status: 'idle' })
  assert.equal(sessionFamilies(store.snapshot().sessions)[0].summary.status, 'working')
})

test('attention promotes overflowed sessions, resolution restores stable order, close hides session', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'buddy-tracking-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = new SessionStore(join(directory, 'sessions.json'))
  for (let i = 0; i < 8; i++) store.apply(event('SessionStart', `session-${i}`))
  const before = store.snapshot().sessions.map((item) => item.id)
  const avatar = store.snapshot().sessions[7].dataUri
  store.apply(event('PermissionRequest', 'session-7', { requestId: 'request-1', tool: 'Bash' }))
  assert.equal(prioritizeSessions(store.snapshot().sessions)[0].id, 'codex:session-7')
  store.apply(event('PermissionRequest', 'session-7', { requestId: 'request-2', tool: 'Read' }))
  store.apply(event('PostToolUse', 'session-7', { requestId: 'request-1', tool: 'Bash' }))
  assert.equal(
    store.snapshot().sessions[7].status,
    'needs-attention',
    'Parallel request remains pending',
  )
  store.apply(event('PostToolUse', 'session-7', { requestId: 'request-2', tool: 'Read' }))
  assert.deepEqual(
    prioritizeSessions(store.snapshot().sessions).map((item) => item.id),
    before,
  )
  assert.equal(store.snapshot().sessions[7].dataUri, avatar)
  store.apply(event('Stop', 'session-7'))
  assert.equal(store.snapshot().sessions.length, 8, 'Idle session stays visible')
  store.apply(event('SessionEnd', 'session-7'))
  assert.equal(store.snapshot().sessions.length, 7)
  assert.equal(store.snapshot().history[0].presence, 'closed')
})

test('restart preserves identities and requires fresh activity before showing live sessions', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'buddy-restart-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'sessions.json')
  const store = new SessionStore(path)
  store.apply(event('SessionStart', 'same-session'))
  const avatar = store.snapshot().sessions[0].dataUri
  const restored = new SessionStore(path)
  assert.equal(restored.snapshot().sessions.length, 0)
  restored.apply(event('UserPromptSubmit', 'same-session'))
  assert.equal(restored.snapshot().sessions[0].dataUri, avatar)
})

test(
  'observer installation is independent of activity and survives executable path changes',
  { timeout: 10_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'buddy-integration-test-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const manager = new IntegrationManager(directory, join(process.cwd(), 'integrations'), true)
    manager.target = () => join(directory, 'hooks.json')
    // Pretend detection passed: this test exercises configuration, never a real home directory.
    manager.detected.set('codex', { compatible: true })
    const catalog = [
      {
        id: 'codex',
        name: 'Codex',
        installation: 'not-checked',
        connection: 'observed',
        observer: 'not-installed',
      },
    ]
    await manager.install('codex')
    let entries = await manager.refresh(catalog)
    assert.equal(entries[0].observer, 'installed')
    assert.equal(entries[0].connection, 'configured')
    const reporterPath = join(directory, 'integrations/reporter.mjs')
    writeFileSync(reporterPath, '// outdated observer')
    await manager.refresh(catalog)
    assert.equal(
      readFileSync(reporterPath, 'utf8'),
      readFileSync('integrations/reporter.mjs', 'utf8'),
      'Refresh updates installed observer assets without reinstalling hooks',
    )
    const target = manager.target('codex')
    const original = readFileSync(target, 'utf8')
    writeFileSync(target, original.replaceAll(process.execPath, '/different/Electron'))
    entries = await manager.refresh(catalog)
    assert.equal(entries[0].observer, 'installed')
    const config = JSON.parse(readFileSync(target, 'utf8'))
    delete config.hooks.Stop
    writeFileSync(target, JSON.stringify(config))
    entries = await manager.refresh(catalog)
    assert.equal(entries[0].observer, 'incomplete')
    manager.remove('codex')
    entries = await manager.refresh(catalog)
    assert.equal(entries[0].observer, 'not-installed')
  },
)

test('turn completion is distinct from initial idle and resets on new work', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'buddy-completion-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = new SessionStore(join(directory, 'sessions.json'))
  store.apply(event('SessionStart', 'codex-session'))
  assert.equal(store.snapshot().sessions[0].status, 'idle')
  store.apply(event('UserPromptSubmit', 'codex-session'))
  store.apply(event('Stop', 'codex-session'))
  assert.equal(store.snapshot().sessions[0].status, 'completed')
  store.apply(event('UserPromptSubmit', 'codex-session'))
  assert.equal(store.snapshot().sessions[0].status, 'working')
  const openCodeEvent = (name, status) =>
    event(name, 'opencode-session', { harness: 'opencode', status })
  store.apply(openCodeEvent('session.status', 'idle'))
  assert.equal(store.snapshot().sessions[1].status, 'idle')
  store.apply(openCodeEvent('session.status', 'busy'))
  store.apply(openCodeEvent('session.idle'))
  assert.equal(store.snapshot().sessions[1].status, 'completed')
  store.apply(openCodeEvent('buddy.reconcile', 'idle'))
  assert.equal(
    store.snapshot().sessions[1].status,
    'completed',
    'Idle heartbeat preserves completion',
  )
  store.apply(openCodeEvent('session.error'))
  store.apply(openCodeEvent('session.idle'))
  assert.equal(store.snapshot().sessions[1].status, 'error', 'An idle event must not hide an error')
  store.apply(openCodeEvent('session.status', 'busy'))
  assert.equal(store.snapshot().sessions[1].status, 'working', 'Fresh work clears the error signal')
})

test('approval hints clear when Codex resumes, even when request IDs differ or PostToolUse is absent', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'buddy-approval-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = new SessionStore(join(directory, 'sessions.json'))
  store.apply(event('UserPromptSubmit', 'approval-session', { turnId: 'turn-1' }))
  store.apply(event('PermissionRequest', 'approval-session', { tool: 'Bash', turnId: 'turn-1' }))
  assert.equal(store.snapshot().sessions[0].status, 'needs-attention')
  store.apply(
    event('PostToolUse', 'approval-session', {
      tool: 'Bash',
      requestId: 'tool-call-1',
      turnId: 'turn-1',
    }),
  )
  assert.equal(
    store.snapshot().sessions[0].status,
    'working',
    'Tool fallback clears despite PostToolUse having a different ID',
  )
  store.apply(event('PermissionRequest', 'approval-session', { tool: 'Bash', turnId: 'turn-1' }))
  store.apply(
    event('PreToolUse', 'approval-session', {
      tool: 'Read',
      requestId: 'tool-call-2',
      turnId: 'turn-1',
    }),
  )
  assert.equal(
    store.snapshot().sessions[0].status,
    'working',
    'New activity supersedes an uncorrelated permission hint',
  )
  store.apply(
    event('PermissionRequest', 'approval-session', {
      tool: 'Bash',
      requestId: 'exact-request',
      turnId: 'turn-1',
    }),
  )
  store.apply(
    event('PreToolUse', 'approval-session', {
      tool: 'Read',
      requestId: 'unrelated-request',
      turnId: 'turn-1',
    }),
  )
  assert.equal(
    store.snapshot().sessions[0].status,
    'needs-attention',
    'Unrelated activity cannot resolve an exact pending request',
  )
  store.apply(
    event('PostToolUse', 'approval-session', {
      tool: 'Bash',
      requestId: 'exact-request',
      turnId: 'turn-1',
    }),
  )
  assert.equal(store.snapshot().sessions[0].status, 'working')
})

test('harness titles replace fallback session names and survive later activity and restarts', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'buddy-titles-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'sessions.json')
  const store = new SessionStore(path)
  store.apply(
    event('session.created', 'named-session', {
      harness: 'opencode',
      title: 'Fix login redirects',
    }),
  )
  store.apply(event('session.status', 'named-session', { harness: 'opencode', status: 'busy' }))
  assert.equal(store.snapshot().sessions[0].name, 'Fix login redirects')
  store.apply(
    event('session.updated', 'named-session', { harness: 'opencode', title: 'Improve login flow' }),
  )
  store.apply(event('session.idle', 'named-session', { harness: 'opencode' }))
  assert.equal(store.snapshot().sessions[0].name, 'Improve login flow')
  const restored = new SessionStore(path)
  assert.equal(restored.snapshot().history[0].name, 'Improve login flow')
  restored.apply(event('UserPromptSubmit', 'codex-1'))
  restored.apply(event('UserPromptSubmit', 'codex-2'))
  const [first, second] = restored.snapshot().sessions
  assert.notEqual(first.name, second.name, 'Untitled hook sessions have distinct stable names')
})

test('legacy project names migrate, Codex title metadata refreshes, and real same-as-project titles survive', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'buddy-names-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'sessions.json')
  const store = new SessionStore(path)
  store.apply(event('SessionStart', 'old-session'))
  store.apply(event('session.created', 'named-project', { harness: 'opencode', title: 'buddy' }))
  const data = JSON.parse(readFileSync(path, 'utf8'))
  data.records[0].name = 'buddy'
  delete data.records[0].nameSource
  delete data.records[0].statusChangedAt
  writeFileSync(path, JSON.stringify(data))
  const index = join(directory, 'session_index.jsonl')
  writeFileSync(
    index,
    '{partial\n' + JSON.stringify({ id: 'old-session', thread_name: 'Fix notch names' }) + '\n',
  )
  const names = new SessionNames(index)
  const restored = new SessionStore(path, (harness, id) => names.lookup(harness, id))
  assert.equal(restored.snapshot().history[0].name, 'Codex 1', 'Legacy project label is replaced')
  assert.equal(restored.snapshot().history[1].name, 'buddy', 'A supplied title is preserved')
  assert(restored.refreshNames())
  restored.apply(event('PreToolUse', 'old-session'))
  assert.equal(restored.snapshot().sessions[0].name, 'Fix notch names')
  writeFileSync(
    index,
    JSON.stringify({ id: 'old-session', thread_name: 'Improve notch names' }) + '\n',
  )
  assert(restored.refreshNames(), 'Rename is picked up without a new turn')
  assert.equal(restored.snapshot().sessions[0].name, 'Improve notch names')
  assert.equal(restored.snapshot().sessions.length, 1, 'Title metadata does not import sessions')
})

test('explicit OpenCode completion works without a preceding busy event, and history keeps final status', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'buddy-late-completion-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = new SessionStore(join(directory, 'sessions.json'))
  store.apply(event('session.idle', 'late-session', { harness: 'opencode' }))
  assert.equal(store.snapshot().sessions[0].status, 'completed')
  store.apply(event('buddy.reconcile', 'late-session', { harness: 'opencode', status: 'idle' }))
  assert.equal(store.snapshot().sessions[0].status, 'completed')
  store.apply(event('Stop', 'codex-session'))
  const changedAt = store.snapshot().sessions[1].statusChangedAt
  store.apply(event('SessionEnd', 'codex-session'))
  assert.equal(store.snapshot().history[0].status, 'completed')
  assert.equal(store.snapshot().history[0].statusChangedAt, changedAt)
})

test('completion notices expire and stop promoting sessions; unresolved attention remains visible', () => {
  const at = Date.now()
  const done = { id: 'done', status: 'completed', statusChangedAt: at, ordinal: 2, attention: [] }
  const working = {
    id: 'working',
    status: 'working',
    statusChangedAt: at,
    ordinal: 1,
    attention: [],
  }
  assert.equal(notchSignal([done, working], at), 'success')
  assert.equal(prioritizeSessions([working, done], at)[0].id, 'done')
  const later = at + COMPLETION_NOTICE_MS
  assert.equal(sessionNotification(done, later), undefined)
  assert.equal(notchSignal([done, working], later), undefined)
  assert.equal(prioritizeSessions([working, done], later)[0].id, 'working')
  assert.equal(done.status, 'completed', 'Notification expiry does not rewrite actual turn outcome')
  const waiting = { ...done, status: 'needs-attention' }
  assert.equal(notchSignal([waiting, done], later), 'attention')
})

test('denied permission hints clear without resolving unrelated exact requests', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'buddy-denied-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = new SessionStore(join(directory, 'sessions.json'))
  const claude = (name, extra) => event(name, 'denied', { harness: 'claude-code', ...extra })
  store.apply(claude('PermissionRequest', { tool: 'Bash' }))
  store.apply(claude('PermissionRequest', { tool: 'Read', requestId: 'parallel' }))
  store.apply(claude('PermissionDenied', { tool: 'Bash', requestId: 'provider-id' }))
  assert.deepEqual(
    store.snapshot().sessions[0].attention.map((item) => item.id),
    ['parallel'],
  )
  store.apply(claude('PermissionDenied', { tool: 'Read', requestId: 'parallel' }))
  assert.equal(store.snapshot().sessions[0].status, 'unknown')
})

test('record identities backfill, retired identities are LRU bounded, and ordinal survives pruning', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'buddy-identities-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'sessions.json')
  const store = new SessionStore(path)
  store.apply(event('SessionStart', 'record'))
  const avatar = store.snapshot().sessions[0].dataUri
  const data = JSON.parse(readFileSync(path, 'utf8'))
  data.identities = Array.from({ length: 10_005 }, (_, i) => ({
    id: `codex:retired-${i}`,
    seed: `seed-${i}`,
    ordinal: i + 1,
    lastUsedAt: i,
  }))
  data.nextOrdinal = 10_006
  writeFileSync(path, JSON.stringify(data))
  const restored = new SessionStore(path)
  restored.apply(event('UserPromptSubmit', 'record'))
  assert.equal(restored.snapshot().sessions[0].dataUri, avatar)
  let saved = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(saved.identities.length, 10_000)
  assert(!saved.identities.some((item) => item.id === 'codex:retired-0'))
  assert(!saved.identities.some((item) => item.id === 'codex:record'))
  restored.apply(event('UserPromptSubmit', 'retired-10004'))
  assert.equal(restored.snapshot().sessions[1].ordinal, 10_005)
  restored.apply(event('UserPromptSubmit', 'new'))
  saved = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(saved.records.at(-1).ordinal, 10_006)
})

test('capacity evicts oldest observed record without disabling tracking and retains its avatar', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'buddy-capacity-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'sessions.json')
  const store = new SessionStore(path)
  store.apply(event('SessionStart', 'template'))
  const data = JSON.parse(readFileSync(path, 'utf8'))
  const template = data.records[0]
  data.records = Array.from({ length: 2000 }, (_, i) => ({
    ...template,
    id: `codex:session-${i}`,
    providerSessionId: `session-${i}`,
    ordinal: i,
    seed: `seed-${i}`,
    lastSeen: i,
  }))
  data.identities = []
  data.nextOrdinal = 2000
  writeFileSync(path, JSON.stringify(data))
  const full = new SessionStore(path)
  // Restore observed presence without doing 2,000 fixture writes.
  for (const record of full.records.values()) record.presence = 'observed'
  const avatar = full.snapshot().sessions[0].dataUri
  assert(full.apply(event('SessionStart', 'overflow')))
  assert.equal(full.snapshot().sessions.length, 2000)
  assert.equal(full.message, null)
  assert.equal(full.capacityEvictions, 1)
  assert(full.apply(event('SessionStart', 'session-0')))
  assert.equal(
    full.snapshot().sessions.find((item) => item.providerSessionId === 'session-0').dataUri,
    avatar,
  )
})

test('tool bursts defer writes, new identities are durable, and persistence failures latch until backoff', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'buddy-flush-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'sessions.json')
  let failures = 0
  const store = new SessionStore(path, () => null, {
    flushDelayMs: 200,
    onPersistenceError: () => failures++,
  })
  t.after(() => store.dispose())
  store.apply(event('SessionStart', 'burst'))
  const avatar = store.snapshot().sessions[0].dataUri
  assert.equal(new SessionStore(path).snapshot().history[0].dataUri, avatar)
  for (let i = 0; i < 20; i++) store.apply(event('PreToolUse', 'burst'))
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).records[0].status, 'idle')
  store.flush()
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).records[0].status, 'working')
  mkdirSync(path + '.tmp')
  store.apply(event('Stop', 'burst'))
  assert.throws(() => store.flush())
  assert.equal(failures, 1)
  assert.equal(store.snapshot().sessions.length, 1)
  for (let i = 0; i < 10; i++) assert.equal(store.apply(event('PreToolUse', 'burst')), false)
  assert.equal(store.droppedObservations, 10)
  assert.equal(store.retryPersistence(), false)
  rmSync(path + '.tmp', { recursive: true })
  assert.equal(store.retryPersistence(Date.now() + 31_000), true)
  assert.equal(store.message, null)
  assert.equal(store.snapshot().sessions.length, 1, 'Recovery retains observed presence')
  store.apply(event('UserPromptSubmit', 'burst'))
  assert.equal(store.snapshot().sessions[0].dataUri, avatar)
})

test('clearing history removes stale metadata and retired identities while preserving live records', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'buddy-clear-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'sessions.json')
  const store = new SessionStore(path)
  store.apply(event('SessionStart', 'live'))
  store.apply(event('SessionStart', 'past'))
  const avatar = store.snapshot().sessions[0].dataUri
  store.apply(event('SessionEnd', 'past'))
  assert.equal(store.snapshot().history.length, 1)
  store.clearHistory()
  assert.equal(store.snapshot().history.length, 0)
  assert.equal(store.snapshot().sessions[0].dataUri, avatar)
  assert.equal(store.get('codex:past'), null)
  const data = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(data.identities.length, 0)
  assert.equal(data.records.length, 1)
  assert.equal(data.nextOrdinal, 2)
})

test(
  'scratch hook install/remove preserves user configuration for both hook harnesses',
  { timeout: 10_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'buddy-config-preservation-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    for (const harness of ['codex', 'claude-code']) {
      const target = join(directory, `${harness}.json`)
      const userHook = {
        matcher: 'keep',
        hooks: [{ type: 'command', command: 'user-owned-command' }],
      }
      writeFileSync(
        target,
        JSON.stringify({
          unrelated: { keep: true },
          hooks: { Stop: [userHook], UserOnly: [userHook] },
        }),
      )
      const manager = new IntegrationManager(
        join(directory, harness),
        join(process.cwd(), 'integrations'),
        true,
      )
      manager.target = () => target
      manager.detected.set(harness, { compatible: true })
      await manager.install(harness)
      await manager.install(harness)
      manager.remove(harness)
      assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), {
        unrelated: { keep: true },
        hooks: { Stop: [userHook], UserOnly: [userHook] },
      })
    }
  },
)

test('all harnesses group nested subagents, preserve canonical status and surface child attention', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'buddy-families-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = new SessionStore(join(directory, 'sessions.json'))
  for (const harness of ['codex', 'claude-code', 'opencode']) {
    if (harness === 'opencode') {
      store.apply(event('session.updated', 'parent', { harness, title: 'Fix routing' }))
      store.apply(event('session.status', 'parent', { harness, status: 'busy' }))
      store.apply(event('session.status', 'child', { harness, parentId: 'parent', status: 'busy' }))
      store.apply(
        event('question.asked', 'grandchild', { harness, parentId: 'child', requestId: 'answer' }),
      )
    } else {
      store.apply(event('UserPromptSubmit', 'parent', { harness }))
      store.apply(event('SubagentStart', 'parent', { harness, agentId: 'child' }))
      store.apply(event('SubagentStart', 'child', { harness, agentId: 'grandchild' }))
      store.apply(event('PermissionRequest', 'grandchild', { harness, requestId: 'permission' }))
    }
  }
  const snapshot = store.snapshot()
  assert.equal(snapshot.sessions.length, 9)
  const families = sessionFamilies(snapshot.sessions, [...snapshot.sessions, ...snapshot.history])
  assert.equal(families.length, 3)
  for (const family of families) {
    assert.equal(family.root.providerSessionId, 'parent')
    assert.equal(family.root.status, 'working', 'Child attention must not mutate parent status')
    assert.equal(family.summary.status, 'needs-attention')
    assert.equal(family.members.length, 3)
    assert.equal(family.descendants.length, 2)
    assert.equal(new Set(family.descendants.map((record) => record.id)).size, 2)
  }
})

test('families use stale ancestor metadata without claiming it is live, and retain orphan/cycle records', () => {
  const record = (id, parentId, ordinal, presence = 'observed', harness = 'opencode') => ({
    id,
    parentId,
    ordinal,
    presence,
    harness,
    status: 'idle',
    name: id,
    attention: [],
    statusChangedAt: 0,
    lastSeen: 0,
  })
  const parent = record('root', null, 1, 'stale')
  const child = record('child', 'root', 2)
  const grandchild = record('grandchild', 'child', 3)
  const families = sessionFamilies([grandchild, child], [parent, child, grandchild])
  assert.equal(families.length, 1)
  assert.equal(families[0].root.id, 'root')
  assert.equal(families[0].root.presence, 'stale')
  assert.equal(families[0].members.length, 2)
  const orphan = record('orphan', 'missing', 4)
  const crossHarness = record('cross', 'root', 5, 'observed', 'codex')
  assert.equal(sessionFamilies([orphan, crossHarness], [parent, orphan, crossHarness]).length, 2)
  const a = record('a', 'b', 7)
  const b = record('b', 'a', 6)
  const cycle = sessionFamilies([a, b])
  assert.equal(cycle.length, 1)
  assert.equal(cycle[0].root.id, 'b')
  assert.equal(cycle[0].members.length, 2)
})

test('relative event ages cover minutes, hours, days and future clock skew', () => {
  const now = 10 * 86400_000
  assert.equal(relativeTime(now + 1000, now), 'just now')
  assert.equal(relativeTime(now - 120_000, now), '2m ago')
  assert.equal(relativeTime(now - 7200_000, now), '2h ago')
  assert.equal(relativeTime(now - 3 * 86400_000, now), '3d ago')
})

test(
  'OpenCode local title lookup is read-only, follows WAL renames, and enriches only observed records',
  { timeout: 10_000 },
  async (t) => {
    const { DatabaseSync } = await import('node:sqlite')
    const directory = mkdtempSync(join(tmpdir(), 'buddy-opencode-title-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const path = join(directory, 'opencode.db')
    const db = new DatabaseSync(path)
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT)')
    db.prepare('INSERT INTO session VALUES (?, ?)').run('ses_observed', 'Fix login')
    db.prepare('INSERT INTO session VALUES (?, ?)').run('ses_history', 'Private unrelated history')
    const reader = new TitleStorage()
    t.after(() => {
      reader.dispose()
      db.close()
    })
    const store = new SessionStore(join(directory, 'sessions.json'), (harness, id) =>
      harness === 'opencode' ? reader.opencode(path, id) : null,
    )
    store.apply(
      event('session.status', 'ses_observed', {
        harness: 'opencode',
        status: 'busy',
        title: 'Old plugin title',
      }),
    )
    assert.equal(store.snapshot().sessions[0].name, 'Fix login')
    assert.equal(store.snapshot().history.length, 0)
    db.prepare('UPDATE session SET title = ? WHERE id = ?').run('Improve login', 'ses_observed')
    const now = Date.now()
    t.mock.method(Date, 'now', () => now + 1500)
    assert(store.refreshNames())
    assert.equal(store.snapshot().sessions[0].name, 'Improve login')
    assert.equal(store.snapshot().sessions[0].status, 'working')
    assert.throws(() =>
      [...reader.databases.values()][0].db
        .prepare('UPDATE session SET title = ?')
        .run('write forbidden'),
    )
    assert.equal(reader.opencode(join(directory, 'missing.db'), 'ses_observed'), null)
    assert(!reader.databases.has(join(directory, 'missing.db')))
    assert.equal(reader.opencode(path, 'ses_observed; DELETE FROM session'), null)
  },
)

test('Claude title lookup reads dedicated metadata, honors custom titles and ignores messages and unrelated IDs', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'buddy-claude-title-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = join(directory, 'projects')
  const project = join(root, '-projects-buddy')
  mkdirSync(project, { recursive: true })
  const id = '12345678-1234-1234-1234-123456789abc'
  const path = join(project, `${id}.jsonl`)
  const title = (type, value, sessionId = id) =>
    JSON.stringify({ type, [type === 'ai-title' ? 'aiTitle' : 'customTitle']: value, sessionId }) +
    '\n'
  writeFileSync(
    path,
    JSON.stringify({
      type: 'user',
      sessionId: id,
      aiTitle: 'Never use message fields',
      message: { content: 'Never use prompts' },
    }) +
      '\n' +
      title('ai-title', 'Fix Buddy sessions') +
      title('custom-title', 'Wrong ID', 'different-id'),
  )
  const reader = new TitleStorage()
  t.after(() => reader.dispose())
  assert.equal(reader.claude(root, id, '/projects/buddy'), 'Fix Buddy sessions')
  writeFileSync(
    path,
    title('ai-title', 'Generated title') + title('custom-title', 'My session title'),
  )
  assert.equal(reader.claude(root, id), 'My session title')
  const initial = readFileSync(path, 'utf8')
  writeFileSync(path, initial + ('x'.repeat(4096) + '\n').repeat(40))
  assert.equal(reader.claude(root, id), 'My session title', 'A cached rename survives file growth')
  writeFileSync(path, readFileSync(path, 'utf8') + title('custom-title', 'Renamed again'))
  assert.equal(reader.claude(root, id), 'Renamed again')
  writeFileSync(path, readFileSync(path, 'utf8') + ('x'.repeat(4096) + '\n').repeat(40))
  assert.equal(
    reader.claude(root, id),
    'Renamed again',
    'Old head metadata cannot overwrite a newer cached rename',
  )
  assert.equal(reader.claude(root, '../../escape'), null)
  const untitled = '12345678-1234-1234-1234-123456789def'
  writeFileSync(
    join(project, `${untitled}.jsonl`),
    JSON.stringify({
      type: 'user',
      aiTitle: 'Private message',
      message: { content: 'Private prompt' },
    }) + '\n',
  )
  assert.equal(reader.claude(root, untitled), null)
})

test(
  'the main title service wires Codex, OpenCode and Claude metadata through canonical session tracking',
  { timeout: 10_000 },
  async (t) => {
    const { DatabaseSync } = await import('node:sqlite')
    const directory = mkdtempSync(join(tmpdir(), 'buddy-all-titles-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const saved = {
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    }
    process.env.XDG_DATA_HOME = directory
    process.env.CLAUDE_CONFIG_DIR = join(directory, 'claude')
    t.after(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    })
    const index = join(directory, 'session_index.jsonl')
    writeFileSync(index, JSON.stringify({ id: 'codex-known', thread_name: 'Codex title' }) + '\n')
    mkdirSync(join(directory, 'opencode'))
    const db = new DatabaseSync(join(directory, 'opencode/opencode.db'))
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT)')
    db.prepare('INSERT INTO session VALUES (?, ?)').run('ses_known', 'OpenCode title')
    const claudeId = '12345678-1234-1234-1234-123456789abc'
    mkdirSync(join(directory, 'claude/projects/-projects-buddy'), { recursive: true })
    writeFileSync(
      join(directory, `claude/projects/-projects-buddy/${claudeId}.jsonl`),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Claude title', sessionId: claudeId }) + '\n',
    )
    const names = new SessionNames(index)
    t.after(() => {
      names.dispose()
      db.close()
    })
    const store = new SessionStore(join(directory, 'sessions.json'), (harness, id, cwd) =>
      names.lookup(harness, id, cwd),
    )
    store.apply(event('SessionStart', 'codex-known'))
    store.apply(event('session.status', 'ses_known', { harness: 'opencode', status: 'busy' }))
    store.apply(event('SessionStart', claudeId, { harness: 'claude-code' }))
    assert.deepEqual(
      store.snapshot().sessions.map((record) => record.name),
      ['Codex title', 'OpenCode title', 'Claude title'],
    )
    assert.equal(store.snapshot().history.length, 0)
  },
)

test('lock/unlock and a short wake retain live sessions and pending approval hints', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'buddy-unlock-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = new SessionStore(join(directory, 'sessions.json'))
  const power = new EventEmitter()
  let publications = 0
  const dispose = observeWake(power, store, () => publications++)
  t.after(dispose)
  const at = Date.now()
  for (const harness of ['codex', 'claude-code', 'opencode']) {
    store.apply(
      event(harness === 'opencode' ? 'permission.asked' : 'PermissionRequest', harness, {
        harness,
        requestId: 'pending',
        tool: 'Bash',
        at,
      }),
      at,
    )
  }
  const before = store.snapshot()
  power.emit('lock-screen')
  power.emit('unlock-screen')
  power.emit('resume')
  assert.deepEqual(store.snapshot(), before)
  assert.equal(publications, 0)
  t.mock.method(Date, 'now', () => at + 10 * 60_000 + 1)
  power.emit('resume')
  assert.equal(store.snapshot().sessions.length, 0)
  assert.equal(publications, 1, 'Only elapsed inactivity expires records')
  dispose()
  assert.equal(power.listenerCount('resume'), 0)
})

test('save failure and recovery preserve idle, working and approval presence without a new event', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'buddy-recovery-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'sessions.json')
  const store = new SessionStore(path, () => null, { flushDelayMs: 200 })
  t.after(() => store.dispose())
  store.apply(event('SessionStart', 'idle'))
  store.apply(event('UserPromptSubmit', 'working'))
  store.apply(event('PermissionRequest', 'approval', { requestId: 'pending' }))
  store.apply(event('PreToolUse', 'working'))
  const before = store.snapshot()
  mkdirSync(path + '.tmp')
  assert.throws(() => store.flush())
  assert.deepEqual(store.snapshot(), before)
  rmSync(path + '.tmp', { recursive: true })
  assert.equal(store.retryPersistence(Date.now() + 31_000), true)
  assert.deepEqual(store.snapshot(), before)
})

test('history snapshots omit avatar payloads while lazy lookup preserves individual identity', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'buddy-history-payload-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = new SessionStore(join(directory, 'sessions.json'))
  store.apply(event('SessionStart', 'past'))
  store.apply(event('SessionStart', 'live'))
  const avatar = store.get('codex:past').dataUri
  store.apply(event('SessionEnd', 'past'))
  const compact = store.snapshot(false)
  assert.equal(compact.history[0].dataUri, '')
  assert(compact.sessions[0].dataUri.startsWith('data:'))
  assert.equal(store.get('codex:past').dataUri, avatar)
  assert(JSON.stringify(compact).length < JSON.stringify(store.snapshot()).length)
})

test('Claude questions are observed without reply hooks and native answers clear their hints', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'buddy-question-observe-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = new SessionStore(join(directory, 'sessions.json'))
  store.apply(
    event('PreToolUse', 'question', {
      harness: 'claude-code',
      tool: 'AskUserQuestion',
      requestId: 'tool-1',
    }),
  )
  assert.equal(store.get('claude-code:question').attention[0].kind, 'question')
  store.apply(
    event('PostToolUse', 'question', {
      harness: 'claude-code',
      tool: 'AskUserQuestion',
      requestId: 'tool-1',
    }),
  )
  assert.equal(store.get('claude-code:question').attention.length, 0)
  assert.equal(store.get('claude-code:question').status, 'working')
})

test('missing Claude titles stay negatively cached across refresh ticks and retry after the longer deadline', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'buddy-title-miss-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = join(directory, 'projects')
  const project = join(root, 'project')
  mkdirSync(project, { recursive: true })
  const id = '12345678-1234-1234-1234-123456789abc'
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const reader = new TitleStorage()
  t.after(() => reader.dispose())
  assert.equal(reader.claude(root, id), null)
  writeFileSync(
    join(project, id + '.jsonl'),
    JSON.stringify({ type: 'ai-title', sessionId: id, aiTitle: 'New title' }) + '\n',
  )
  now += 15_001
  assert.equal(
    reader.claude(root, id),
    null,
    'A refresh tick cannot repeat a full missing-title scan',
  )
  now += 5 * 60_000
  assert.equal(reader.claude(root, id), 'New title')
})

test('name refresh processes a bounded batch and eventually visits every session', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'buddy-name-budget-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const lookedUp = []
  const store = new SessionStore(join(directory, 'sessions.json'), (_harness, id) => {
    lookedUp.push(id)
    return null
  })
  for (let i = 0; i < 40; i++) store.apply(event('SessionStart', 'session-' + i))
  lookedUp.length = 0
  store.refreshNames()
  assert.equal(lookedUp.length, 32)
  store.refreshNames()
  assert.equal(new Set(lookedUp).size, 40)
})
