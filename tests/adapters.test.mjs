import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadSource } from './load-source.mjs'
import { metadata, report } from '../integrations/reporter.mjs'

const {
  HARNESS_IDS,
  isHarnessId,
  ADAPTERS,
  HARNESSES,
  normalizeObservation,
  harnessFor,
  parseCliVersion,
  isCliVersion,
} = await loadSource('tests/adapters-entry.ts')
const normalize = (harness, event, extra = {}) =>
  normalizeObservation({
    version: 1,
    id: 'event',
    at: Date.now(),
    harness,
    event,
    sessionId: 'parent',
    ...extra,
  })

test('observation envelopes reject malformed identity, timestamps and unsupported contracts', () => {
  const now = 1_000_000
  const valid = {
    version: 1,
    id: 'event',
    at: now,
    harness: 'codex',
    event: 'SessionStart',
    sessionId: 'session',
  }
  for (const invalid of [
    null,
    [],
    'event',
    { ...valid, version: 2 },
    { ...valid, harness: 'unknown' },
    { ...valid, id: '' },
    { ...valid, id: 'bad\nidentity' },
    { ...valid, sessionId: 'x'.repeat(129) },
    { ...valid, at: NaN },
    { ...valid, at: Infinity },
    { ...valid, at: String(now) },
    { ...valid, at: now + 5001 },
    { ...valid, at: now - 60_001 },
    { ...valid, event: 'InventedEvent' },
  ])
    assert.equal(normalizeObservation(invalid, now), null)
  assert(normalizeObservation({ ...valid, at: now - 60_000 }, now))
  assert(normalizeObservation({ ...valid, at: now + 5000 }, now))
  const clean = normalizeObservation(
    { ...valid, source: 'app-server', status: 'error', cwd: 'bad\npath', tool: 'x'.repeat(121) },
    now,
  )
  assert.equal(clean.source, 'hooks')
  assert.equal(clean.status, 'idle', 'The provider cannot supply canonical status')
  assert.equal(clean.cwd, null)
  assert.equal(clean.tool, null)
})

test(
  'reporter sends only allowlisted metadata and tolerates an unavailable bridge',
  { timeout: 2000 },
  async () => {
    const observation = metadata({
      harness: 'opencode',
      event: 'question.asked',
      sessionId: 'session',
      title: '  Fix\nlogin  ',
      cwd: '/projects/app',
      prompt: 'private prompt',
      messages: ['private message'],
      tool_input: { password: 'secret' },
      tool_response: 'private result',
      error: 'private error',
      attention: [{ id: 'question', kind: 'question', details: 'private details' }],
    })
    assert.equal(observation.title, 'Fix login')
    assert.deepEqual(observation.attention, [{ id: 'question', kind: 'question' }])
    assert(!JSON.stringify(observation).includes('private'))
    assert(!JSON.stringify(observation).includes('secret'))
    assert.notEqual(metadata({}).id, metadata({}).id)
    await assert.doesNotReject(report('/missing-buddy-test-profile/bridge.json', observation))
  },
)

test('adapter registry is exhaustive and renderer fallback tolerates a missing catalog entry', () => {
  assert.deepEqual(Object.keys(ADAPTERS), [...HARNESS_IDS])
  assert.deepEqual(
    HARNESSES.map((adapter) => adapter.id),
    [...HARNESS_IDS],
  )
  assert(!isHarnessId('constructor'))
  assert(!isHarnessId({ toString: () => 'codex' }))
  assert.equal(harnessFor({ harnesses: [] }, 'codex').shortLabel, '?')
  for (const adapter of HARNESSES) {
    assert.equal(adapter.id, ADAPTERS[adapter.id].id)
    assert.equal(typeof adapter.displayName(12), 'string')
    assert.equal(typeof adapter.setupCopy('install', '/scratch/config'), 'string')
  }
})

test('adapter event fixtures preserve lifecycle, completion and provider-specific semantics', () => {
  for (const [harness, event, extra, status, action] of [
    ['codex', 'SessionStart', {}, 'idle', 'observe'],
    ['codex', 'UserPromptSubmit', {}, 'working', 'observe'],
    ['codex', 'PermissionRequest', {}, 'needs-attention', 'permission'],
    ['codex', 'Stop', {}, 'completed', 'observe'],
    ['codex', 'SessionEnd', {}, null, 'close'],
    ['claude-code', 'PermissionDenied', {}, null, 'resolve'],
    [
      'claude-code',
      'PermissionRequest',
      { tool: 'AskUserQuestion' },
      'needs-attention',
      'question',
    ],
    ['claude-code', 'PostToolUseFailure', {}, 'error', 'observe'],
    [
      'claude-code',
      'Notification',
      { notificationType: 'permission_prompt' },
      'needs-attention',
      'permission',
    ],
    ['opencode', 'session.created', { title: 'Title' }, null, 'metadata'],
    ['opencode', 'session.status', { status: 'retry' }, 'working', 'observe'],
    ['opencode', 'session.status', { status: 'running' }, 'working', 'observe'],
    ['opencode', 'session.status', { status: 'idle' }, 'idle', 'observe'],
    ['opencode', 'session.idle', {}, 'completed', 'observe'],
    ['opencode', 'permission.v2.asked', {}, 'needs-attention', 'permission'],
    ['opencode', 'question.asked', {}, 'needs-attention', 'question'],
    ['opencode', 'question.rejected', {}, null, 'resolve'],
  ]) {
    const mapped = normalize(harness, event, extra)
    assert(mapped, `${harness}:${event}`)
    assert.equal(mapped.status, status)
    assert.equal(mapped.action, action)
  }
  for (const event of ['PermissionDenied', 'StopFailure', 'Notification', 'PostToolUseFailure'])
    assert.equal(normalize('codex', event), null)
  assert.equal(normalize('claude-code', 'Notification', { notificationType: 'other' }), null)
  assert.equal(normalize('opencode', 'session.status', { status: 'invented' }), null)
  assert.equal(normalize('opencode', 'buddy.reconcile', { status: 'busy', attention: [{}] }), null)
  assert.equal(normalize('opencode', 'session.updated', { title: 'Title' }).name, 'Title')
})

test('subagents remap only distinct IDs and never self-parent', () => {
  for (const harness of ['codex', 'claude-code']) {
    const child = normalize(harness, 'SubagentStart', { agentId: 'child', turnId: 'parent-turn' })
    assert.equal(child.sessionId, 'child')
    assert.equal(child.parentId, 'parent')
    assert.equal(child.turnId, null)
    const same = normalize(harness, 'SubagentStart', { agentId: 'parent' })
    assert.equal(same.sessionId, 'parent')
    assert.equal(same.parentId, null)
  }
  const child = normalize('claude-code', 'PreToolUse', { agentId: 'child' })
  assert.equal(child.parentId, 'parent')
  const same = normalize('claude-code', 'PreToolUse', { agentId: 'parent', parentId: 'parent' })
  assert.equal(same.parentId, null)
})

test('version detection retains prerelease and build identities for exact-version consent', () => {
  assert.equal(
    parseCliVersion('codex-cli 0.162.1-preview.2+custom.3'),
    '0.162.1-preview.2+custom.3',
  )
  assert.equal(parseCliVersion('Claude 2.1.295'), '2.1.295')
  assert.equal(parseCliVersion('opencode v2.0.28'), '2.0.28')
  assert(isCliVersion('1.18.35-beta'))
  assert(!isCliVersion('not a version'))
  assert(ADAPTERS.opencode.compat.matches('2.0.0'))
  assert(ADAPTERS.opencode.compat.matches('2.4.1-beta.2'))
  assert(!ADAPTERS.opencode.compat.matches('1.18.35'))
  assert(!ADAPTERS.opencode.compat.supports('1.18.35'))
})

test('failure and interruption metadata use each harness contract without fabricated hook events', () => {
  assert.equal(normalize('codex', 'PostToolUse', { toolFailed: true }).status, 'error')
  assert.equal(normalize('codex', 'Interrupt').status, 'interrupted')
  assert.equal(normalize('codex', 'StopFailure'), null)
  assert.equal(
    normalize('claude-code', 'PostToolUseFailure', { interrupted: true }).status,
    'interrupted',
  )
  assert.equal(normalize('claude-code', 'PostToolUse', { interrupted: true }).status, 'interrupted')
  assert.equal(normalize('opencode', 'session.error', { interrupted: true }).status, 'interrupted')
})
