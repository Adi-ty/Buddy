import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import { loadSource } from './load-source.mjs'
import { hookRequest, hookOutput } from '../integrations/control-hook.mjs'
import { inputDigest } from '../integrations/reporter.mjs'
const { RequestBridge } = await loadSource('tests/requests-entry.ts')

const waitFor = async (check) => {
  const end = Date.now() + 4000
  while (Date.now() < end) {
    if (check()) return
    await new Promise((done) => setTimeout(done, 10))
  }
  throw new Error('Request fixture did not settle')
}
async function fixture(t, enabled = () => true) {
  const profile = mkdtempSync(join(tmpdir(), 'buddy-requests-'))
  const resolved = []
  const bridge = new RequestBridge(
    profile,
    enabled,
    () => {},
    () => {},
    (...p) => resolved.push(p),
  )
  t.after(() => {
    bridge.dispose()
    rmSync(profile, { recursive: true, force: true })
  })
  await bridge.start()
  const config = JSON.parse(readFileSync(join(profile, 'controls.json'), 'utf8'))
  const client = async (harness = 'claude-code', credential = config.token) => {
    const socket = connect(config.socket)
    const messages = []
    let input = ''
    socket.setEncoding('utf8')
    t.after(() => socket.destroy())
    socket.on('data', (chunk) => {
      input += chunk
      while (input.includes('\n')) {
        messages.push(JSON.parse(input.slice(0, input.indexOf('\n'))))
        input = input.slice(input.indexOf('\n') + 1)
      }
    })
    await new Promise((done, reject) => {
      socket.once('connect', done)
      socket.once('error', reject)
    })
    socket.on('error', () => {})
    const send = (p) => socket.write(JSON.stringify(p) + '\n')
    send({ op: 'hello', harness, token: credential })
    return { socket, messages, send }
  }
  return { profile, bridge, resolved, client }
}
const permission = (id = 'request-1', sessionId = 'session-1') => ({
  op: 'request',
  id,
  sessionId,
  kind: 'permission',
  hook: true,
  tool: 'Bash',
  details: '{"command":"echo fixture"}',
  turnId: 'turn-1',
})

test(
  'hook and plugin approvals use exact live request IDs, await acknowledgment, and reject duplicate or stale clicks',
  { timeout: 10_000 },
  async (t) => {
    const { bridge, resolved, client } = await fixture(t)
    for (const harness of ['claude-code', 'opencode']) {
      const source = await client(harness)
      await waitFor(() => source.messages.some((p) => p.op === 'ready'))
      source.send(permission())
      await waitFor(() => bridge.snapshot().length === 1)
      const request = bridge.snapshot()[0]
      assert.equal(request.sessionId, `${harness}:session-1`)
      await bridge.respond(request.id, { decision: 'allow' })
      assert.equal(bridge.snapshot()[0].submitting, true)
      await assert.rejects(() => bridge.respond(request.id, { decision: 'allow' }), /already/)
      await waitFor(() => source.messages.some((p) => p.op === 'reply'))
      assert.deepEqual(source.messages.find((p) => p.op === 'reply').response, {
        decision: 'allow',
      })
      source.send({ op: 'result', id: 'another-request', ok: true })
      await new Promise((done) => setTimeout(done, 20))
      assert.equal(bridge.snapshot().length, 1)
      source.send({ op: 'result', id: 'request-1', ok: true })
      await waitFor(() => !bridge.snapshot().length)
      assert.equal(resolved.at(-1)[1], 'allow')
      await assert.rejects(() => bridge.respond(request.id, { decision: 'allow' }), /ended/)
      source.socket.destroy()
    }
  },
)

test(
  'another source cannot resolve a request, and native resolution, disconnect and turn cancellation retire controls',
  { timeout: 10_000 },
  async (t) => {
    const { bridge, client } = await fixture(t)
    const owner = await client()
    const other = await client()
    owner.send(permission())
    await waitFor(() => bridge.snapshot().length)
    other.send({ op: 'resolved', id: 'request-1' })
    await new Promise((done) => setTimeout(done, 20))
    assert.equal(bridge.snapshot().length, 1)
    owner.send({ op: 'resolved', id: 'request-1' })
    await waitFor(() => !bridge.snapshot().length)
    owner.send(permission('next'))
    await waitFor(() => bridge.snapshot().length)
    bridge.reconcile([
      { id: 'claude-code:session-1', presence: 'observed', status: 'working', turnId: 'new-turn' },
    ])
    assert.equal(bridge.snapshot().length, 0)
    owner.send(permission('last'))
    await waitFor(() => bridge.snapshot().length)
    owner.socket.destroy()
    await waitFor(() => !bridge.snapshot().length)
  },
)

test(
  'a second connection re-sending the same request is retired without duplicating the prompt',
  { timeout: 10_000 },
  async (t) => {
    const { bridge, client } = await fixture(t)
    const owner = await client('opencode')
    const other = await client('opencode')
    owner.send({ ...permission(), hook: false })
    await waitFor(() => bridge.snapshot().length === 1)
    other.send({ ...permission(), hook: false })
    await waitFor(() => other.messages.some((p) => p.op === 'retired' && p.id === 'request-1'))
    await new Promise((done) => setTimeout(done, 20))
    assert.equal(bridge.snapshot().length, 1)
    owner.send({ op: 'resolved', id: 'request-1' })
    await waitFor(() => !bridge.snapshot().length)
  },
)

test(
  'question responses require every answer and preserve multi-select/custom text without selecting defaults',
  { timeout: 10_000 },
  async (t) => {
    const { bridge, client } = await fixture(t)
    const source = await client('claude-code')
    source.send({
      ...permission(),
      kind: 'question',
      questions: [
        { text: 'Framework?', options: [{ label: 'React', description: 'UI' }], custom: true },
        {
          text: 'Targets?',
          multiple: true,
          options: [
            { label: 'Mac', description: '' },
            { label: 'Web', description: '' },
          ],
        },
      ],
    })
    await waitFor(() => bridge.snapshot().length)
    const request = bridge.snapshot()[0]
    await assert.rejects(
      () => bridge.respond(request.id, { answers: [[], ['Mac']] }),
      /Answer each/,
    )
    await assert.rejects(
      () => bridge.respond(request.id, { answers: [['Other'], ['Linux']] }),
      /Answer each/,
    )
    await bridge.respond(request.id, { answers: [['Custom framework'], ['Mac', 'Web']] })
    await waitFor(() => source.messages.some((p) => p.op === 'reply'))
    assert.deepEqual(source.messages.find((p) => p.op === 'reply').response.answers, [
      ['Custom framework'],
      ['Mac', 'Web'],
    ])
    source.send({ op: 'result', id: 'request-1', ok: false })
    await waitFor(() => bridge.snapshot()[0]?.error)
    assert.equal(bridge.snapshot()[0].submitting, false)
    await bridge.respond(request.id, { decision: 'native' })
  },
)

test(
  'disabled controls and invalid credentials never expose actionable requests',
  { timeout: 10_000 },
  async (t) => {
    const { bridge, client } = await fixture(t, () => false)
    const source = await client()
    source.send(permission())
    await waitFor(() => source.messages.some((p) => p.op === 'disabled'))
    assert.equal(bridge.snapshot().length, 0)
    const bad = await client('codex', '0'.repeat(64))
    await waitFor(() => bad.socket.destroyed)
    assert.equal(bad.messages.length, 0)
  },
)

test(
  'Claude hooks emit once-only policy output and legacy Codex hooks immediately leave approval in Codex',
  { timeout: 10_000 },
  async (t) => {
    const { bridge, profile } = await fixture(t)
    for (const [harness, decision] of [
      ['claude-code', 'allow'],
      ['claude-code', 'reject'],
      ['codex', 'native'],
    ]) {
      const input = {
        session_id: `hook-${harness}`,
        cwd: '/projects/fixture',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'echo fixture', description: 'Test only' },
      }
      const child = spawn(
        process.execPath,
        [resolve('integrations/control-hook.mjs'), harness, join(profile, 'controls.json')],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      )
      t.after(() => {
        if (child.exitCode === null) child.kill()
      })
      let output = ''
      child.stdout.on('data', (data) => {
        output += data
      })
      const exit = new Promise((done, reject) => {
        child.once('exit', done)
        child.once('error', reject)
      })
      child.stdin.end(JSON.stringify(input))
      if (harness !== 'codex') {
        await waitFor(() => bridge.snapshot().length)
        await bridge.respond(bridge.snapshot()[0].id, { decision })
      }
      assert.equal(await exit, 0)
      if (harness === 'codex') assert.equal(output, '')
      else
        assert.equal(
          JSON.parse(output).hookSpecificOutput.decision.behavior,
          decision === 'allow' ? 'allow' : 'deny',
        )
      assert.equal(bridge.snapshot().length, 0)
    }
  },
)

test(
  'legacy Codex control packets cannot create a separate Buddy-only approval',
  { timeout: 10_000 },
  async (t) => {
    const { bridge, client } = await fixture(t)
    const source = await client('codex')
    source.send(permission())
    await waitFor(() => source.messages.some((message) => message.op === 'retired'))
    assert.equal(bridge.snapshot().length, 0)
    assert(!source.messages.some((message) => message.op === 'reply'))
  },
)

test('hook questions race the native prompt, echo original inputs and leave unsupported requests to the agent', () => {
  const input = {
    session_id: 'claude',
    hook_event_name: 'PermissionRequest',
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [
        {
          question: 'Which framework?',
          header: 'Framework',
          multiSelect: false,
          options: [{ label: 'React', description: 'UI' }],
        },
      ],
    },
  }
  const request = hookRequest('claude-code', input)
  assert.equal(request.kind, 'question')
  assert.equal(request.sessionId, 'claude')
  assert.match(request.inputDigest, /^[0-9a-f]{64}$/)
  assert.equal(request.inputDigest, inputDigest('AskUserQuestion', input.tool_input))
  assert.equal(hookRequest('claude-code', { ...input, hook_event_name: 'PreToolUse' }), null)
  assert.equal(hookRequest('claude-code', { ...input, agent_id: 'subagent' }), null)
  assert.equal(hookRequest('claude-code', { ...input, tool_name: 'ExitPlanMode' }), null)
  assert.equal(hookRequest('codex', input), null)
  const output = hookOutput(input, { answers: [['Vue']] })
  assert.equal(output.hookSpecificOutput.hookEventName, 'PermissionRequest')
  assert.equal(output.hookSpecificOutput.decision.behavior, 'allow')
  const updated = output.hookSpecificOutput.decision.updatedInput
  assert.deepEqual(updated.questions, input.tool_input.questions)
  assert.deepEqual(updated.answers, { 'Which framework?': 'Vue' })
  assert.equal(hookOutput(input, { decision: 'allow' }), null)
  assert.equal(hookOutput(input, { decision: 'native' }), null)
  assert.equal(
    hookRequest('codex', {
      ...input,
      hook_event_name: 'PermissionRequest',
      tool_input: { command: 'x'.repeat(64_000) },
    }),
    null,
  )
  assert.equal(
    hookRequest('claude-code', {
      ...input,
      tool_name: 'Bash',
      tool_input: { command: 'x'.repeat(64_000) },
    }),
    null,
  )
})

test('input digests ignore key order but distinguish tools and inputs', () => {
  assert.equal(
    inputDigest('Bash', { command: 'ls', description: 'List' }),
    inputDigest('Bash', { description: 'List', command: 'ls' }),
  )
  assert.notEqual(inputDigest('Bash', { command: 'ls' }), inputDigest('Read', { command: 'ls' }))
  assert.notEqual(inputDigest('Bash', { command: 'ls' }), inputDigest('Bash', { command: 'pwd' }))
  assert.equal(inputDigest(undefined, {}), undefined)
})

test(
  'a Claude request answered in its own prompt retires when its exact tool call runs',
  { timeout: 10_000 },
  async (t) => {
    const { bridge, client } = await fixture(t)
    const owner = await client('claude-code')
    await waitFor(() => owner.messages.some((p) => p.op === 'ready'))
    const digest = (command) => inputDigest('Bash', { command })
    const tool = (event, requestId, command) =>
      bridge.observeTool({
        harness: 'claude-code',
        sessionId: 'session-1',
        event,
        requestId,
        inputDigest: event === 'PreToolUse' ? digest(command) : null,
      })
    tool('PreToolUse', 'toolu-ls', 'ls')
    tool('PreToolUse', 'toolu-rm', 'rm build')
    owner.send({ ...permission(), inputDigest: digest('rm build') })
    await waitFor(() => bridge.snapshot().length === 1)
    tool('PostToolUse', 'toolu-ls')
    await new Promise((done) => setTimeout(done, 20))
    assert.equal(bridge.snapshot().length, 1)
    bridge.observeTool({
      harness: 'claude-code',
      sessionId: 'session-2',
      event: 'PostToolUse',
      requestId: 'toolu-rm',
    })
    assert.equal(bridge.snapshot().length, 1)
    tool('PostToolUse', 'toolu-rm')
    await waitFor(() => !bridge.snapshot().length)
    await waitFor(() => owner.messages.some((p) => p.op === 'retired' && p.id === 'request-1'))
    owner.send({ ...permission('late'), inputDigest: digest('make') })
    await waitFor(() => bridge.snapshot().length === 1)
    tool('PreToolUse', 'toolu-make', 'make')
    tool('PostToolUseFailure', 'toolu-make')
    await waitFor(() => !bridge.snapshot().length)
  },
)

test('ambiguous OpenCode replies remain locked until native retirement', async (t) => {
  const { bridge, client } = await fixture(t)
  const source = await client('opencode')
  source.send({ ...permission(), hook: false })
  await waitFor(() => bridge.snapshot().length)
  const { id } = bridge.snapshot()[0]
  await bridge.respond(id, { decision: 'allow' })
  source.send({ op: 'result', id: 'request-1', ok: false, uncertain: true })
  await waitFor(() => bridge.snapshot()[0]?.error)
  assert.equal(bridge.snapshot()[0].submitting, true)
  await assert.rejects(bridge.respond(id, { decision: 'allow' }), /already/)
  source.send({ op: 'resolved', id: 'request-1' })
  await waitFor(() => !bridge.snapshot().length)
})
