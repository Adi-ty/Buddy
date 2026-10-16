import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSource } from './load-source.mjs'
const { TelegramService, TelegramClient, TelegramError, TelegramStorage, RequestService } =
  await loadSource('tests/telegram-entry.ts')
const token = '123456789:' + 'fixture_only_not_a_real_token_12345'
const defaults = {
  permissions: true,
  questions: true,
  completions: true,
  failures: true,
  paused: false,
}
const waitFor = async (check) => {
  for (let i = 0; i < 400; i++) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.fail('Telegram fixture did not settle')
}
class FakeTransport {
  calls = []
  updates = []
  poll = null
  nextMessage = 10
  messages = new Map()
  fail = null
  webhook = ''
  async call(method, body, signal) {
    this.calls.push({ method, body: structuredClone(body) })
    if (this.fail) {
      const failure = this.fail(method, body)
      if (failure) throw failure
    }
    if (method === 'getMe') return { id: 123, is_bot: true, username: 'buddy_test_bot' }
    if (method === 'getWebhookInfo') return { url: this.webhook }
    if (method === 'getUpdates') {
      if (this.updates.length) return this.updates.splice(0)
      return new Promise((resolve, reject) => {
        const abort = () => {
          this.poll = null
          reject(new Error('Aborted'))
        }
        signal.addEventListener('abort', abort, { once: true })
        this.poll = (updates) => {
          signal.removeEventListener('abort', abort)
          this.poll = null
          resolve(updates)
        }
        if (signal.aborted) abort()
      })
    }
    if (method === 'sendMessage') {
      const result = {
        ...body,
        message_id: this.nextMessage++,
        from: { id: 123 },
        chat: { id: body.chat_id, type: 'private' },
      }
      this.messages.set(result.message_id, result)
      return result
    }
    if (method.startsWith('editMessage')) {
      const result = { ...this.messages.get(body.message_id), ...body }
      this.messages.set(body.message_id, result)
      return result
    }
    return true
  }
  push(update) {
    if (this.poll) this.poll([update])
    else this.updates.push(update)
  }
}
const permission = (id = 'request') => ({
  id,
  sessionId: 'opencode:s',
  harness: 'opencode',
  kind: 'permission',
  tool: 'Bash',
  details: 'echo <fixture> & *literal*',
  questions: [],
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  deadlineSource: 'buddy',
  submitting: false,
  error: null,
})
async function fixture(t, options = {}) {
  let live = options.live ?? []
  const transport = new FakeTransport()
  let saved = options.saved ?? { pair: null, offset: 0, preferences: { ...defaults }, messages: [] }
  let credential = null
  const storage = {
    load: () => structuredClone(saved),
    save: (data) => {
      saved = structuredClone(data)
    },
    token: async () => credential,
    storeToken: async (value, valid = () => true) => {
      if (valid()) credential = value
    },
    clear: () => {
      credential = null
      saved = { pair: null, offset: 0, preferences: { ...defaults }, messages: [] }
    },
  }
  const answers = []
  const requests = new RequestService(
    () => live,
    () => true,
    async (id, answer) => {
      answers.push({ id, answer })
      live = live.map((r) => (r.id === id ? { ...r, submitting: true } : r))
    },
  )
  const service = new TelegramService({
    storage,
    requests,
    changed: () => {},
    client: () => transport,
    sendInterval: 0,
  })
  t.after(() => service.dispose())
  let updateId = options.saved?.offset ?? 0
  const message = (text, extra = {}, user = 456, chat = 456) => ({
    update_id: ++updateId,
    message: {
      text,
      message_id: 900 + updateId,
      from: { id: user, first_name: 'Test' },
      chat: { id: chat, type: 'private' },
      ...extra,
    },
  })
  const push = (value) => transport.push(value)
  const challenge = await service.connect(token)
  const pair = async () => {
    const code = new URL(challenge.url).searchParams.get('start')
    push(message('/start ' + code))
    await waitFor(() => service.status().pairedUser)
    await waitFor(() => transport.calls.some((c) => c.method === 'sendMessage'))
  }
  const button = (text) => {
    for (const m of [...transport.messages.values()].reverse()) {
      const b = m.reply_markup?.inline_keyboard?.flat().find((b) => b.text === text)
      if (b) return { m, b }
    }
    return null
  }
  const tap = async (text, user = 456, transform = (m) => m) => {
    await waitFor(() => button(text))
    const { m, b } = button(text)
    push({
      update_id: ++updateId,
      callback_query: {
        id: 'tap-' + updateId,
        from: { id: user },
        message: transform(m),
        data: b.callback_data,
      },
    })
    return { m, b }
  }
  return {
    service,
    transport,
    requests,
    answers,
    challenge,
    pair,
    push,
    message,
    tap,
    button,
    saved: () => saved,
    credential: () => credential,
    live: (value, sessions = []) => {
      live = value
      service.reconcile(sessions)
    },
  }
}

test('transport validates tokens, redacts URL-bearing failures, parses retry_after, and never enables formatting', async () => {
  assert.throws(() => new TelegramClient('bad'))
  const client = new TelegramClient(token, async (url) => {
    throw new Error('Failed fetching ' + url)
  })
  await assert.rejects(
    client.call('getMe', {}, new AbortController().signal),
    (error) => !String(error).includes(token) && !String(error).includes('https'),
  )
  const rate = new TelegramClient(
    token,
    async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 429,
          description: token,
          parameters: { retry_after: 12 },
        }),
        { status: 429 },
      ),
  )
  await assert.rejects(
    rate.call('sendMessage', {}, new AbortController().signal),
    (error) => error.code === 429 && error.retryAfter === 12 && !error.message.includes(token),
  )
})

test('credentials use only encrypted storage; identity and message metadata are bounded', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-telegram-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const cipher = {
    available: async () => true,
    encrypt: async () => Buffer.from('encrypted fixture'),
    decrypt: async () => token,
  }
  const storage = new TelegramStorage(dir, cipher)
  await storage.storeToken(token)
  assert.equal(await storage.token(), token)
  storage.save({
    pair: { chat: 1, user: 1, label: 'Test' },
    offset: 2,
    preferences: defaults,
    messages: Array.from({ length: 300 }, (_, i) => ({ chat: 1, message: i, at: Date.now() })),
  })
  assert.equal(storage.load().messages.length, 256)
  for (const name of readdirSync(dir)) {
    assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600)
    assert(!readFileSync(join(dir, name), 'utf8').includes(token))
  }
  storage.clear()
  assert.equal(await storage.token(), null)
  assert.equal(storage.load().pair, null)
  const insecure = new TelegramStorage(dir, { ...cipher, available: async () => false })
  await assert.rejects(insecure.storeToken(token), /unavailable/)
  await storage.storeToken(token, () => false)
  assert.equal(await storage.token(), null)
})

test('pairing requires an unexpired one-time challenge and a private user identity', async (t) => {
  const f = await fixture(t)
  const code = new URL(f.challenge.url).searchParams.get('start')
  f.push(f.message('/start wrong'))
  f.push(f.message('/start ' + code, { chat: { id: -5, type: 'group' } }))
  f.push(f.message('/start ' + code, { from: { id: 456, is_bot: true } }))
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(f.service.status().pairedUser, null)
  const second = f.service.pairing()
  f.push(f.message('/start ' + code))
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(f.service.status().pairedUser, null)
  f.push(f.message('/start ' + new URL(second.url).searchParams.get('start')))
  await waitFor(() => f.service.status().pairedUser)
  assert.match(f.service.status().pairedUser, /456/)
  assert.throws(() => f.service.pairingLink(second.url), /no longer available/)
  f.push(f.message('/start ' + code, {}, 789, 789))
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(f.saved().pair.user, 456)
  assert(!JSON.stringify(f.service.status()).includes(token))
  assert(!JSON.stringify(f.saved()).includes(code))
})

test('clipboard accepts only the current live pairing link without rotating it', async (t) => {
  const f = await fixture(t)
  assert.equal(f.service.pairingLink(f.challenge.url), f.challenge.url)
  assert.equal(f.service.pairingLink(f.challenge.url), f.challenge.url)
  for (const value of [null, {}, 123, token, 'https://example.com'])
    assert.throws(() => f.service.pairingLink(value), /no longer available/)
  const next = f.service.pairing()
  assert.throws(() => f.service.pairingLink(f.challenge.url), /no longer available/)
  const original = Date.now
  Date.now = () => next.expiresAt
  try {
    assert.throws(() => f.service.pairingLink(next.url), /no longer available/)
  } finally {
    Date.now = original
  }
  assert.equal(f.service.pairingLink(next.url), next.url)
  f.service.disconnect()
  assert.throws(() => f.service.pairingLink(next.url), /no longer available/)
})

test('pairing expiry cannot authorize a chat', async (t) => {
  const f = await fixture(t)
  const original = Date.now
  Date.now = () => f.challenge.expiresAt + 1
  try {
    f.push(f.message('/start ' + new URL(f.challenge.url).searchParams.get('start')))
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(f.service.status().pairedUser, null)
  } finally {
    Date.now = original
  }
})

test('permissions require exact paired user/chat/bot message; taps and updates cannot replay', async (t) => {
  const f = await fixture(t, { live: [permission()] })
  await f.pair()
  await waitFor(() => f.button('Allow once'))
  const { m, b } = f.button('Allow once')
  assert(Buffer.byteLength(b.callback_data) <= 64)
  assert(!b.callback_data.includes('request'))
  assert.equal(m.parse_mode, undefined)
  assert.equal(
    m.text,
    '🔐 Permission requested\n\nSession: Unavailable\nAgent: OpenCode\nProject: Unavailable\n\nTool: Bash\n\necho <fixture> & *literal*',
  )
  await f.tap('Allow once', 789)
  await f.tap('Allow once', 456, (m) => ({ ...m, chat: { id: 789, type: 'private' } }))
  await f.tap('Allow once', 456, (m) => ({ ...m, from: { id: 789 } }))
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(f.answers.length, 0)
  await f.tap('Allow once')
  await waitFor(() => f.answers.length === 1)
  const repeated = {
    update_id: 100,
    callback_query: { id: 'repeat', from: { id: 456 }, message: m, data: b.callback_data },
  }
  f.push(repeated)
  f.push(repeated)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(f.answers.length, 1)
  assert(f.transport.calls.some((c) => c.method === 'answerCallbackQuery'))
  assert(![...f.transport.messages.values()].some((m) => m.text?.includes('Answered in Telegram')))
  f.requests.resolve('request', 'confirmed')
  f.live([])
  await waitFor(() =>
    [...f.transport.messages.values()].some((m) => m.text?.includes('Answered in Telegram')),
  )
})

test('multi-question drafts support single, multiple, boolean and reply-bound custom text with final submission', async (t) => {
  const r = {
    ...permission(),
    kind: 'question',
    tool: null,
    details: 'Choose settings',
    questions: [
      {
        text: 'Single?',
        multiple: false,
        custom: false,
        options: [{ label: 'One', description: '' }],
      },
      {
        text: 'Multiple?',
        multiple: true,
        custom: false,
        options: [
          { label: 'A', description: '' },
          { label: 'B', description: '' },
        ],
      },
      {
        text: 'Boolean?',
        multiple: false,
        custom: false,
        options: [
          { label: 'Yes', description: '' },
          { label: 'No', description: '' },
        ],
      },
      { text: 'Free text?', multiple: false, custom: true, options: [] },
    ],
  }
  const f = await fixture(t, { live: [r] })
  await f.pair()
  await f.tap('One')
  await waitFor(() => f.button('✓ One'))
  await f.tap('2')
  await f.tap('A')
  await waitFor(() => f.button('✓ A'))
  await f.tap('B')
  await waitFor(() => f.button('✓ B'))
  await f.tap('3')
  await f.tap('Yes')
  await waitFor(() => f.button('✓ Yes'))
  await f.tap('4')
  await f.tap('Type an answer…')
  await waitFor(() => [...f.transport.messages.values()].some((m) => m.reply_markup?.force_reply))
  const prompt = [...f.transport.messages.values()].find((m) => m.reply_markup?.force_reply)
  assert.match(prompt.text, /^✏️ Your answer\n\nSession: Unavailable\nAgent: OpenCode/)
  assert.match(prompt.text, /Question 4 of 4\nFree text\?/)
  f.push(f.message('arbitrary text'))
  f.push(f.message('wrong user', { reply_to_message: prompt }, 789))
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(f.answers.length, 0)
  f.push(f.message('Custom <&> answer', { reply_to_message: prompt }))
  await waitFor(() =>
    [...f.transport.messages.values()].some((m) => m.text?.includes('Answer: Custom <&> answer')),
  )
  assert.equal(f.answers.length, 0)
  await f.tap('Submit all answers')
  await waitFor(() => f.answers.length === 1)
  assert.deepEqual(f.answers[0].answer, {
    answers: [['One'], ['A', 'B'], ['Yes'], ['Custom <&> answer']],
  })
})

test('native retirement and known expiry invalidate old buttons even when edits fail', async (t) => {
  const f = await fixture(t, { live: [permission()] })
  await f.pair()
  await waitFor(() => f.button('Allow once'))
  const { m, b } = f.button('Allow once')
  f.transport.fail = (method) => (method.startsWith('editMessage') ? new TelegramError(0) : null)
  f.requests.resolve('request', 'expired')
  f.live([])
  await waitFor(() => f.service.status().message.includes('could not'))
  f.push({
    update_id: 500,
    callback_query: { id: 'stale', from: { id: 456 }, message: m, data: b.callback_data },
  })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(f.answers.length, 0)
  assert(f.saved().messages.length > 0)
})

test('restart mappings remove keyboards and never restore persisted answer authority', async (t) => {
  // Connect replacement deliberately clears old identity. Restore through start.
  const transport = new FakeTransport()
  const saved = {
    pair: { chat: 456, user: 456, label: 'Test' },
    offset: 45,
    preferences: defaults,
    messages: [{ chat: 456, message: 99, at: Date.now() }],
  }
  let data = structuredClone(saved)
  const service = new TelegramService({
    storage: {
      load: () => data,
      save: (d) => {
        data = structuredClone(d)
      },
      token: async () => token,
      storeToken: async () => {},
      clear: () => {},
    },
    requests: new RequestService(
      () => [],
      () => true,
      async () => assert.fail(),
    ),
    changed: () => {},
    client: () => transport,
    sendInterval: 0,
  })
  t.after(() => service.dispose())
  await service.start()
  await waitFor(() => transport.calls.some((c) => c.method === 'editMessageReplyMarkup'))
  assert.deepEqual(
    transport.calls.find((c) => c.method === 'editMessageReplyMarkup').body.reply_markup,
    { inline_keyboard: [] },
  )
  assert.equal(transport.calls.find((c) => c.method === 'getUpdates').body.offset, 45)
  assert(!transport.calls.some((c) => c.method === 'sendMessage'))
})

test('disconnect cancels polling, clears encrypted credential and revokes pending answer authority', async (t) => {
  const f = await fixture(t, { live: [permission()] })
  await f.pair()
  await waitFor(() => f.button('Allow once'))
  const { m, b } = f.button('Allow once')
  f.service.disconnect()
  assert.equal(f.service.status().state, 'disconnected')
  assert.equal(f.credential(), null)
  assert.equal(f.saved().pair, null)
  f.push({
    update_id: 500,
    callback_query: { id: 'old', from: { id: 456 }, message: m, data: b.callback_data },
  })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(f.answers.length, 0)
})

test('oversized requests show native fallback without truncated approval controls', async (t) => {
  const f = await fixture(t, { live: [{ ...permission(), details: 'x'.repeat(5000) }] })
  await f.pair()
  await waitFor(() => [...f.transport.messages.values()].some((m) => m.text?.includes('too large')))
  assert.equal(f.button('Allow once'), null)
  assert([...f.transport.messages.values()].every((m) => m.text.length <= 4096))
})

test('ambiguous sends are not blindly retried, while explicit rate limits can retry', async (t) => {
  const f = await fixture(t)
  await f.pair()
  f.transport.fail = (method, body) =>
    method === 'sendMessage' && body.text.includes('Permission requested')
      ? new TelegramError(0)
      : null
  f.live([permission()])
  await waitFor(() => f.service.status().message.includes('could not'))
  for (let i = 0; i < 3; i++) f.service.reconcile([])
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(
    f.transport.calls.filter(
      (c) => c.method === 'sendMessage' && c.body.text.includes('Permission requested'),
    ).length,
    1,
  )
  let failures = 1
  f.transport.fail = (method) =>
    method === 'sendMessage' && failures-- > 0 ? new TelegramError(429, 0) : null
  f.live([permission('new')])
  await waitFor(() => f.button('Allow once'))
})

test('sleep/wake replaces callback handles and only rebuilds live requests', async (t) => {
  const f = await fixture(t, { live: [permission()] })
  await f.pair()
  await waitFor(() => f.button('Allow once'))
  const old = f.button('Allow once').b.callback_data
  f.service.suspend()
  assert.equal(f.service.status().state, 'suspended')
  f.service.resume()
  await waitFor(() => f.button('Allow once')?.b.callback_data !== old)
  assert.equal(f.service.status().state, 'connected')
})

test('notifications use confirmed terminal transitions and preserve parent context', async (t) => {
  const f = await fixture(t)
  await f.pair()
  const base = {
    id: 'child',
    name: 'Child',
    parentId: 'parent',
    harness: 'codex',
    project: 'Repo',
    turnId: 'turn',
    presence: 'observed',
    turnActive: true,
    status: 'working',
  }
  f.service.reconcile([{ id: 'parent', name: 'Parent', harness: 'codex' }, base])
  f.service.observe(null, { ...base, status: 'completed' })
  f.service.observe(base, { ...base, status: 'error', turnActive: true })
  f.service.observe(base, { ...base, status: 'unknown', presence: 'stale' })
  f.service.observe(base, { ...base, status: 'completed', turnActive: false })
  f.service.observe(base, { ...base, status: 'error', turnActive: false })
  await waitFor(() =>
    [...f.transport.messages.values()].some((m) => m.text?.includes('turn failed')),
  )
  const alerts = [...f.transport.messages.values()].filter((m) => m.text?.includes('Subagent turn'))
  assert.deepEqual(
    alerts.map((m) => m.text),
    [
      '✅ Subagent turn finished\n\nSession: Parent\nSubagent: Child\nAgent: Codex\nProject: Repo',
      '❌ Subagent turn failed\n\nSession: Parent\nSubagent: Child\nAgent: Codex\nProject: Repo',
    ],
  )
})

test('completion alerts identify the session and use display names for every harness', async (t) => {
  const f = await fixture(t)
  await f.pair()
  for (const [harness, agent] of [
    ['codex', 'Codex'],
    ['claude-code', 'Claude Code'],
    ['opencode', 'OpenCode'],
  ]) {
    const before = {
      id: `${harness}:s`,
      name: 'Build <Buddy> & *test*',
      harness,
      project: 'buddy',
      presence: 'observed',
      status: 'working',
      turnActive: true,
    }
    f.service.observe(before, { ...before, status: 'completed', turnActive: false })
    await waitFor(() =>
      [...f.transport.messages.values()].some(
        (m) =>
          m.text ===
          `✅ Turn finished\n\nSession: Build <Buddy> & *test*\nAgent: ${agent}\nProject: buddy`,
      ),
    )
  }
  assert([...f.transport.messages.values()].every((m) => m.parse_mode === undefined))
})

test('nested subagent requests show the root session and keep that context after answering', async (t) => {
  const r = permission()
  const f = await fixture(t)
  await f.pair()
  const root = { id: 'root', name: 'Build Buddy', harness: 'opencode', project: 'buddy' }
  const parent = { ...root, id: 'parent', parentId: 'root', name: 'Review' }
  const child = { ...root, id: r.sessionId, parentId: 'parent', name: 'Check tests' }
  f.live([r], [root, parent, child])
  await waitFor(() => f.button('Allow once'))
  const context = 'Session: Build Buddy\nSubagent: Check tests\nAgent: OpenCode\nProject: buddy'
  assert(f.button('Allow once').m.text.includes(context))
  await f.tap('Allow once')
  await waitFor(() => f.answers.length === 1)
  f.requests.resolve(r.id, 'confirmed')
  f.live([])
  await waitFor(() =>
    [...f.transport.messages.values()].some(
      (m) =>
        m.text?.startsWith('✅ Answered in Telegram') &&
        m.text.includes(context) &&
        m.reply_markup.inline_keyboard.length === 0,
    ),
  )
})

test('late session metadata updates the same alert and bounds labels without shortening the request', async (t) => {
  const r = permission()
  const f = await fixture(t, { live: [r] })
  await f.pair()
  await waitFor(() => f.button('Allow once'))
  const original = f.button('Allow once').m.message_id
  const session = {
    id: r.sessionId,
    harness: r.harness,
    parentId: 'missing-parent',
    name: 'x'.repeat(158) + '🤖' + 'y'.repeat(1000),
    project: 'buddy\nrepo',
  }
  f.service.reconcile([session])
  await waitFor(() => f.button('Allow once')?.m.text.includes('Subagent:'))
  const updated = f.button('Allow once').m
  assert.equal(updated.message_id, original)
  assert(
    updated.text.includes(
      `Session: Unavailable\nSubagent: ${'x'.repeat(158)}…\nAgent: OpenCode\nProject: buddy repo`,
    ),
  )
  assert(updated.text.endsWith(r.details))
  assert(updated.text.isWellFormed())
  assert(updated.text.length <= 4096)
})

test('invalid tokens and existing webhooks fail without starting polling or saving credentials', async (t) => {
  for (const code of [401, 409]) {
    const transport = new FakeTransport()
    if (code === 401) transport.fail = () => new TelegramError(401)
    else transport.webhook = 'https://another-service.invalid/webhook'
    let saved = false
    const service = new TelegramService({
      storage: {
        load: () => ({ pair: null, offset: 0, preferences: defaults, messages: [] }),
        save: () => {},
        token: async () => null,
        storeToken: async () => {
          saved = true
        },
        clear: () => {},
      },
      requests: new RequestService(
        () => [],
        () => true,
        async () => {},
      ),
      changed: () => {},
      client: () => transport,
    })
    t.after(() => service.dispose())
    await assert.rejects(service.connect(token))
    assert.equal(saved, false)
    assert.equal(service.status().state, code === 401 ? 'error' : 'conflict')
    assert(!transport.calls.some((c) => c.method === 'getUpdates'))
  }
})

test('a revoked token stops polling and tells the user how to replace it', async (t) => {
  const f = await fixture(t)
  await f.pair()
  f.transport.fail = (method) => (method === 'getUpdates' ? new TelegramError(401) : null)
  f.push(f.message('trigger next poll'))
  await waitFor(() => f.service.status().state === 'error')
  assert.equal(
    f.service.status().message,
    'Telegram rejected the bot token. Disconnect and enter the new token from BotFather.',
  )
  const count = f.transport.calls.length
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(f.transport.calls.length, count)
})

test('polling conflict stops work and reconnect explicitly resumes', async (t) => {
  const f = await fixture(t)
  await f.pair()
  f.transport.fail = (method) => (method === 'getUpdates' ? new TelegramError(409) : null)
  f.push(f.message('trigger next poll'))
  await waitFor(() => f.service.status().state === 'conflict')
  const count = f.transport.calls.length
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(f.transport.calls.length, count)
  f.transport.fail = null
  await f.service.reconnect()
  assert.equal(f.service.status().state, 'connected')
})

test('network loss backs off and recovers polling without dropping the paired identity', async (t) => {
  const f = await fixture(t)
  await f.pair()
  let failed = false
  f.transport.fail = (method) => {
    if (method !== 'getUpdates' || failed) return null
    failed = true
    return new TelegramError(0)
  }
  f.push(f.message('trigger next poll'))
  await waitFor(() => f.service.status().state === 'offline')
  assert.equal(f.saved().pair.user, 456)
  await waitFor(() => !!f.transport.poll)
  f.push(f.message('reconnected'))
  await waitFor(() => f.service.status().state === 'connected')
})

test('a laptop answer wins against an open Telegram keyboard without misattribution', async (t) => {
  const f = await fixture(t, { live: [permission()] })
  await f.pair()
  await waitFor(() => f.button('Allow once'))
  const { m, b } = f.button('Allow once')
  await f.requests.respond('request', { decision: 'reject' }, 'buddy')
  f.push({
    update_id: 500,
    callback_query: { id: 'race', from: { id: 456 }, message: m, data: b.callback_data },
  })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(f.answers.length, 1)
  assert.deepEqual(f.answers[0].answer, { decision: 'reject' })
  f.requests.resolve('request', 'unavailable')
  f.live([])
  await waitFor(() =>
    [...f.transport.messages.values()].some((m) => m.text?.includes('No longer pending')),
  )
  assert(![...f.transport.messages.values()].some((m) => m.text?.includes('Answered in Telegram')))
})

test('expiry between notification and submission never dispatches an answer', async (t) => {
  const r = permission()
  const f = await fixture(t, { live: [r] })
  await f.pair()
  await waitFor(() => f.button('Allow once'))
  r.expiresAt = 0
  await f.tap('Allow once')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(f.answers.length, 0)
})

test('late message delivery after native resolution cannot install fresh answer handles', async (t) => {
  const f = await fixture(t)
  await f.pair()
  const call = f.transport.call.bind(f.transport)
  let release
  f.transport.call = async (method, body, signal) => {
    if (method === 'sendMessage' && body.text.includes('Permission requested')) {
      await new Promise((r) => {
        release = r
      })
    }
    return call(method, body, signal)
  }
  f.live([permission()])
  await waitFor(() => release)
  f.live([])
  release()
  await waitFor(() =>
    [...f.transport.messages.values()].some((m) => m.text?.includes('No longer pending')),
  )
  assert.equal(f.button('Allow once'), null)
  assert.equal(f.answers.length, 0)
})

test('disconnect during validation cannot revive pairing or store a credential', async (t) => {
  const transport = new FakeTransport()
  const call = transport.call.bind(transport)
  let release
  transport.call = async (...args) => {
    if (args[0] === 'getMe')
      await new Promise((r) => {
        release = r
      })
    return call(...args)
  }
  let credential = null
  const service = new TelegramService({
    storage: {
      load: () => ({ pair: null, offset: 0, preferences: defaults, messages: [] }),
      save: () => {},
      token: async () => null,
      storeToken: async (value) => {
        credential = value
      },
      clear: () => {
        credential = null
      },
    },
    requests: new RequestService(
      () => [],
      () => true,
      async () => {},
    ),
    changed: () => {},
    client: () => transport,
  })
  t.after(() => service.dispose())
  const connecting = service.connect(token)
  await waitFor(() => release)
  service.disconnect()
  release()
  await connecting
  assert.equal(service.status().state, 'disconnected')
  assert.equal(credential, null)
  assert(!transport.calls.some((c) => c.method === 'getUpdates'))
})

test('notification categories and pause suppress new notices but still retire existing controls', async (t) => {
  const f = await fixture(t, { live: [permission()] })
  await f.pair()
  await waitFor(() => f.button('Allow once'))
  f.service.preferences({ ...defaults, paused: true })
  f.live([permission('new')])
  await waitFor(() =>
    [...f.transport.messages.values()].some((m) => m.text?.includes('No longer pending')),
  )
  assert.equal(f.button('Allow once'), null)
  f.service.preferences({ ...defaults, permissions: false })
  assert.equal(f.button('Allow once'), null)
  f.service.preferences(defaults)
  await waitFor(() => f.button('Allow once'))
})

test('retirement overtakes queued draft edits without dropping keyboard cleanup', async (t) => {
  const f = await fixture(t)
  await f.pair()
  const call = f.transport.call.bind(f.transport)
  let release
  let blocked = false
  f.transport.call = async (method, body, signal) => {
    if (method === 'sendMessage' && body.text.includes('blocking') && !blocked) {
      blocked = true
      await new Promise((r) => {
        release = r
      })
    }
    return call(method, body, signal)
  }
  const one = { ...permission('one'), details: 'blocking' }
  const two = { ...permission('two'), details: 'queued' }
  f.live([one, two])
  await waitFor(() => release)
  f.live([])
  release()
  await waitFor(
    () =>
      [...f.transport.messages.values()].filter((m) => m.text?.includes('No longer pending'))
        .length === 2,
  )
  assert.equal(f.button('Allow once'), null)
  assert.equal(f.answers.length, 0)
})

test('an ambiguous send is not repeated when the live request subsequently changes', async (t) => {
  const f = await fixture(t)
  await f.pair()
  f.transport.fail = (method) => (method === 'sendMessage' ? new TelegramError(0) : null)
  const r = permission()
  f.live([r])
  await waitFor(() => f.service.status().message.includes('could not'))
  const count = f.transport.calls.filter((c) => c.method === 'sendMessage').length
  f.live([{ ...r, submitting: true }])
  f.live([])
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(f.transport.calls.filter((c) => c.method === 'sendMessage').length, count)
})

test('unavailable normalized decisions direct the user to the native interface', async (t) => {
  const f = await fixture(t, { live: [{ ...permission(), allowedDecisions: [] }] })
  await f.pair()
  await waitFor(() =>
    [...f.transport.messages.values()].some((m) => m.text?.includes('native interface')),
  )
  assert.equal(f.button('Allow once'), null)
  assert.equal(f.button('Reject'), null)
})

test('offline recovery retries failed edits, never an ambiguous agent mutation', async (t) => {
  const r = {
    ...permission(),
    kind: 'question',
    details: 'Choices',
    questions: [
      {
        text: 'Which?',
        multiple: false,
        custom: false,
        options: [{ label: 'A', description: '' }],
      },
    ],
  }
  const f = await fixture(t, { live: [r] })
  await f.pair()
  let offline = true
  f.transport.fail = (method) =>
    offline && (method === 'editMessageText' || method === 'getUpdates')
      ? new TelegramError(0)
      : null
  await f.tap('A')
  await waitFor(() => f.service.status().state === 'offline')
  offline = false
  await waitFor(() => f.transport.poll)
  f.push(f.message('recovered'))
  await waitFor(() => f.button('✓ A'))
  assert.equal(f.answers.length, 0)
})

test('week-old offsets reset without treating persisted requests as live', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-telegram-offset-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const storage = new TelegramStorage(dir, { available: async () => false })
  storage.save({
    pair: null,
    offset: 500,
    lastUpdateAt: Date.now() - 8 * 86_400_000,
    preferences: defaults,
    messages: [],
  })
  assert.equal(storage.load().offset, 0)
})

const notifyCompletion = (f) => {
  const before = {
    id: 's',
    name: 'Task',
    harness: 'codex',
    project: 'Repo',
    presence: 'observed',
    status: 'working',
    turnActive: true,
  }
  f.service.observe(before, { ...before, status: 'completed', turnActive: false })
}

test('delivery warning survives healthy polling and clears after a successful outgoing notification', async (t) => {
  const f = await fixture(t)
  await f.pair()
  f.transport.fail = (method) => (method === 'sendMessage' ? new TelegramError(0) : null)
  notifyCompletion(f)
  await waitFor(() => f.service.status().deliveryProblem)
  const offset = f.saved().offset
  f.push(f.message('poll succeeds while sends still fail'))
  await waitFor(() => f.saved().offset > offset)
  assert.equal(f.service.status().state, 'connected')
  assert.equal(f.service.status().deliveryProblem, true)
  f.transport.fail = null
  notifyCompletion(f)
  await waitFor(() => !f.service.status().deliveryProblem)
  assert(!f.service.status().message.includes('could not'))
})

test('unconfirmed pending requests keep the warning despite later successful sends, without resending', async (t) => {
  const f = await fixture(t)
  await f.pair()
  f.transport.fail = (method, body) =>
    method === 'sendMessage' && body.text.includes('Permission requested')
      ? new TelegramError(0)
      : null
  f.live([permission()])
  await waitFor(() => f.service.status().deliveryProblem)
  f.transport.fail = null
  notifyCompletion(f)
  await waitFor(() =>
    [...f.transport.messages.values()].some((m) => m.text?.includes('Turn finished')),
  )
  f.push(f.message('healthy polling'))
  await waitFor(() => f.saved().offset > 1)
  assert.equal(f.service.status().deliveryProblem, true)
  assert.equal(
    f.transport.calls.filter(
      (c) => c.method === 'sendMessage' && c.body.text.includes('Permission requested'),
    ).length,
    1,
  )
  f.live([])
  assert.equal(f.service.status().deliveryProblem, false)
})

test('failed retirement edits remain visible until a confirmed repair, even when polling never fails', async (t) => {
  const f = await fixture(t, { live: [permission()] })
  await f.pair()
  await waitFor(() => f.button('Allow once'))
  f.transport.fail = (method) => (method === 'editMessageText' ? new TelegramError(0) : null)
  f.live([])
  await waitFor(() => f.service.status().deliveryProblem)
  f.service.reconcile([]) // Must retain the failed retirement until it is repaired.
  notifyCompletion(f)
  await waitFor(() =>
    [...f.transport.messages.values()].some((m) => m.text?.includes('Turn finished')),
  )
  assert.equal(f.service.status().deliveryProblem, true)
  f.transport.fail = null
  f.push(f.message('retry safe edits'))
  await waitFor(() =>
    [...f.transport.messages.values()].some((m) => m.text?.includes('No longer pending')),
  )
  assert.equal(f.service.status().deliveryProblem, false)
  assert.equal(f.button('Allow once'), null)
  assert.equal(f.answers.length, 0)
})

test('failed persisted keyboard cleanup stays visible until that cleanup succeeds', async (t) => {
  const f = await fixture(t)
  await f.pair()
  f.live([permission()])
  await waitFor(() => f.button('Allow once'))
  const oldMessage = f.button('Allow once').m.message_id
  f.service.suspend()
  f.live([])
  f.transport.fail = (method) => (method === 'editMessageReplyMarkup' ? new TelegramError(0) : null)
  f.service.resume()
  await waitFor(() => f.service.status().deliveryProblem)
  notifyCompletion(f)
  await waitFor(() =>
    [...f.transport.messages.values()].some((m) => m.text?.includes('Turn finished')),
  )
  assert.equal(f.service.status().deliveryProblem, true)
  f.transport.fail = null
  f.push(f.message('cleanup may retry'))
  await waitFor(() => !f.saved().messages.some((m) => m.message === oldMessage))
  assert.equal(f.service.status().deliveryProblem, false)
})

test('disconnect and a fresh connection clear delivery warnings; late old failures cannot restore them', async (t) => {
  const f = await fixture(t)
  await f.pair()
  f.transport.fail = (method) => (method === 'sendMessage' ? new TelegramError(0) : null)
  notifyCompletion(f)
  await waitFor(() => f.service.status().deliveryProblem)
  f.service.disconnect()
  assert.equal(f.service.status().deliveryProblem, false)
  f.transport.fail = null
  const challenge = await f.service.connect(token)
  assert.equal(f.service.status().deliveryProblem, false)
  f.push(f.message('/start ' + new URL(challenge.url).searchParams.get('start')))
  await waitFor(() => f.service.status().pairedUser)
  const call = f.transport.call.bind(f.transport)
  let rejectOld
  f.transport.call = (method, body, signal) =>
    method === 'sendMessage' && body.text.includes('Turn finished')
      ? new Promise((_resolve, reject) => {
          rejectOld = reject
        })
      : call(method, body, signal)
  notifyCompletion(f)
  await waitFor(() => rejectOld)
  f.service.disconnect()
  await f.service.connect(token)
  rejectOld(new TelegramError(0))
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(f.service.status().deliveryProblem, false)
  assert.equal(f.service.status().state, 'pairing')
})

test('late outgoing success from an old connection cannot erase a new delivery failure', async (t) => {
  const f = await fixture(t)
  await f.pair()
  const call = f.transport.call.bind(f.transport)
  let resolveOld
  f.transport.call = (method, body, signal) =>
    method === 'sendMessage' && body.text.includes('Turn finished')
      ? new Promise((resolve) => {
          resolveOld = resolve
        })
      : call(method, body, signal)
  notifyCompletion(f)
  await waitFor(() => resolveOld)
  f.service.disconnect()
  f.transport.call = call
  const challenge = await f.service.connect(token)
  f.push(f.message('/start ' + new URL(challenge.url).searchParams.get('start')))
  await waitFor(() => f.service.status().pairedUser)
  // Let the welcome message complete before failing a fresh notification.
  await waitFor(
    () =>
      [...f.transport.messages.values()].filter((m) => m.text?.startsWith('Paired with')).length ===
      2,
  )
  f.transport.fail = (method) => (method === 'sendMessage' ? new TelegramError(0) : null)
  notifyCompletion(f)
  await waitFor(() => f.service.status().deliveryProblem)
  resolveOld({ message_id: 999 })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(f.service.status().deliveryProblem, true)
})
