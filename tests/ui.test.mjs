import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { loadSource } from './load-source.mjs'
const {
  IntegrationsPage,
  SessionRow,
  SessionList,
  setSessionFilters,
  OverlaySessions,
  sessionPage,
  nextSessionRow,
  RequestPanel,
  SessionRequests,
  familyInputSession,
  sessionFamilies,
  errorMessage,
} = await loadSource('tests/ui-entry.tsx')

test('approval errors remove Electron routing prefixes and empty errors use an actionable fallback', () => {
  const raw =
    "Error invoking remote method 'buddy:respond-to-request': Error: This request has ended. Check Codex."
  assert.equal(errorMessage(new Error(raw), 'Try again'), 'This request has ended. Check Codex.')
  assert.equal(errorMessage(null, 'Try again'), 'Try again')
  assert.equal(errorMessage(new Error(''), 'Try again'), 'Try again')
  const html = renderToStaticMarkup(
    createElement(RequestPanel, {
      request: {
        id: 'error',
        harness: 'codex',
        sessionId: 'thread',
        kind: 'permission',
        tool: 'Bash',
        details: 'echo test',
        questions: [],
        submitting: false,
        error: raw,
      },
    }),
  )
  assert(html.includes('This request has ended. Check Codex.'))
  assert(!html.includes('Error invoking remote method'))
  assert(!html.includes('buddy:respond-to-request'))
})
const harness = {
  id: 'codex',
  name: 'Codex',
  shortLabel: 'CX',
  observer: 'installed',
  connection: 'observed',
  installation: 'installed',
  version: '0.162.1',
  canInstall: true,
}
const snapshot = {
  harnesses: [harness],
  tracking: { available: true, message: null },
  avatarPreviews: [
    {
      harness: 'codex',
      dataUri: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E',
    },
  ],
}

test('pending request UI escapes arguments, identifies its session and requires explicit answers', () => {
  const request = {
    id: 'request',
    harness: 'codex',
    sessionId: 'session',
    kind: 'permission',
    tool: 'Bash',
    details: '<script>bad()</script>',
    questions: [],
    submitting: false,
    error: null,
  }
  const html = renderToStaticMarkup(
    createElement(RequestPanel, { request, sessionName: 'Fix login' }),
  )
  assert(html.includes('Allow once'))
  assert(html.includes('Deny'))
  assert(html.includes('Use agent window'))
  assert(html.includes('Fix login'))
  assert(html.includes('&lt;script&gt;'))
  assert(!html.includes('<script>'))
  const question = renderToStaticMarkup(
    createElement(RequestPanel, {
      request: {
        ...request,
        kind: 'question',
        questions: [
          {
            text: 'Framework?',
            header: 'Framework',
            multiple: false,
            custom: true,
            options: [{ label: 'React', description: 'UI' }],
          },
        ],
      },
    }),
  )
  assert(!question.includes('checked=""'))
  assert.match(question, /disabled=""[^>]*>Send answers/)
})

test('installed observer confirms setup and only offers removal, even without events', () => {
  for (const connection of ['configured', 'observed', 'stale']) {
    const html = renderToStaticMarkup(
      createElement(IntegrationsPage, {
        snapshot: { ...snapshot, harnesses: [{ ...harness, connection }] },
      }),
    )
    assert(html.includes('Observer installed'))
    assert(html.includes('Remove observer'))
    assert(!html.includes('Install observer'))
  }
  const html = renderToStaticMarkup(
    createElement(IntegrationsPage, {
      snapshot: { ...snapshot, harnesses: [{ ...harness, observer: 'not-installed' }] },
    }),
  )
  assert(html.includes('Install observer'))
  assert(!html.includes('Remove observer'))
})

test('session rows convey permission, completion and errors using text as well as animated signals', () => {
  for (const [status, signal, label] of [
    ['needs-attention', 'attention', 'Needs attention'],
    ['completed', 'success', 'Finished'],
    ['error', 'error', 'Error'],
  ]) {
    const session = {
      id: 'test',
      name: 'Codex 1',
      project: 'buddy',
      dataUri: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E',
      status,
      attention: [],
    }
    const html = renderToStaticMarkup(
      createElement(SessionRow, { session, harness, onSelect() {} }),
    )
    assert(html.includes(`data-signal="${signal}"`))
    assert(html.includes(label))
  }
})

test('overlay rows expose expanded state and details; selection rows expose pressed state', () => {
  const session = {
    id: 'aria-contract',
    name: 'ARIA contract',
    project: 'buddy',
    dataUri: 'data:image/svg+xml,%3Csvg/%3E',
    status: 'working',
    attention: [],
  }
  const render = (props, children) =>
    renderToStaticMarkup(
      createElement(SessionRow, { session, harness, onSelect() {}, ...props }, children),
    )
  const closed = render({ expandable: true })
  assert.match(closed, /aria-expanded="false"/)
  assert(!closed.includes('aria-pressed'))
  assert(!closed.includes('session-row-details'))
  const open = render(
    { expandable: true, selected: true },
    createElement('p', null, 'Session details'),
  )
  assert.match(open, /aria-expanded="true"/)
  assert(!open.includes('aria-pressed'))
  assert(open.includes('<p>Session details</p>'))
  for (const compact of [false, true]) {
    const selected = render({ compact, selected: true })
    assert.match(selected, /aria-pressed="true"/)
    assert(!selected.includes('aria-expanded'))
  }
})

test('session name is primary and subtitle identifies the harness without repeating the project', () => {
  const session = {
    id: 'named-session',
    name: 'Fix login redirects',
    project: 'buddy',
    dataUri: 'data:image/svg+xml,%3Csvg/%3E',
    status: 'working',
    attention: [],
  }
  const html = renderToStaticMarkup(createElement(SessionRow, { session, harness, onSelect() {} }))
  assert(html.includes('title="Fix login redirects"'))
  assert(html.indexOf('Fix login redirects') < html.indexOf('>Codex<'))
  assert(!html.includes('Codex · buddy'))
})

test('unverified installs are explicit and missing preview metadata does not crash integrations', () => {
  const html = renderToStaticMarkup(
    createElement(IntegrationsPage, {
      snapshot: {
        ...snapshot,
        avatarPreviews: [],
        harnesses: [
          {
            ...harness,
            observer: 'not-installed',
            version: '9.9.9',
            compatibility: 'unverified',
            canInstall: false,
            canInstallUnverified: true,
          },
        ],
      },
    }),
  )
  assert(html.includes('Install anyway (unverified)'))
  assert(html.includes('may misreport activity'))
  assert(!html.includes('Install observer'))
})

test('history search survives page remounts, live filters stay separate, and rows have one tab stop', (t) => {
  t.after(() =>
    setSessionFilters(true, {
      search: '',
      harness: 'all',
      project: 'all',
      status: 'all',
      recent: 'all',
      sort: 'default',
      groupBy: 'none',
    }),
  )
  const session = (id, name, project, cwd) => ({
    id,
    name,
    project,
    cwd,
    harness: 'codex',
    providerSessionId: id,
    source: 'hooks',
    presence: 'closed',
    dataUri: snapshot.avatarPreviews[0].dataUri,
    status: 'completed',
    statusChangedAt: Date.now(),
    ordinal: Number(id),
    firstSeen: Date.now(),
    lastSeen: Date.now(),
    attention: [],
    activity: [],
  })
  const history = [
    session('1', 'Fix login', 'app', '/projects/app'),
    session('2', 'Update docs', 'docs', '/projects/docs'),
  ]
  const current = {
    ...snapshot,
    sessions: history.map((record) => ({ ...record, presence: 'observed' })),
    history,
  }
  setSessionFilters(true, { search: 'LOGIN' })
  for (let i = 0; i < 2; i++) {
    const html = renderToStaticMarkup(
      createElement(SessionList, { snapshot: current, history: true }),
    )
    assert(html.includes('1 of 2 past sessions'))
    assert(!html.includes('Update docs'))
    renderToStaticMarkup(createElement(IntegrationsPage, { snapshot }))
  }
  const live = renderToStaticMarkup(createElement(SessionList, { snapshot: current }))
  assert(live.includes('2 of 2 observed sessions'))
  assert.equal((live.match(/tabindex="0"/g) ?? []).length, 1)
  assert.equal((live.match(/tabindex="-1"/g) ?? []).length, 1)
  assert(live.includes('Reveal project'))
  assert(live.includes('title="/projects/docs"'))
})

test('a parent family is one dashboard entry, with child details and an honest aggregate status', () => {
  const parent = {
    id: 'opencode:parent',
    providerSessionId: 'parent',
    harness: 'opencode',
    name: 'Fix routing',
    cwd: '/projects/buddy',
    project: 'buddy',
    parentId: null,
    status: 'working',
    presence: 'observed',
    ordinal: 0,
    statusChangedAt: Date.now(),
    lastSeen: Date.now(),
    attention: [],
    activity: [],
    dataUri: snapshot.avatarPreviews[0].dataUri,
  }
  const child = {
    ...parent,
    id: 'opencode:child',
    providerSessionId: 'child',
    name: 'Investigate routes',
    parentId: parent.id,
    ordinal: 1,
    status: 'needs-attention',
    attention: [{ id: 'question', kind: 'question', tool: null }],
  }
  const html = renderToStaticMarkup(
    createElement(SessionList, {
      snapshot: {
        ...snapshot,
        harnesses: [{ ...harness, id: 'opencode', name: 'OpenCode' }],
        sessions: [parent, child],
        history: [],
      },
    }),
  )
  assert(html.includes('1 of 1 observed sessions'))
  assert(html.includes('1 subagent'))
  assert(html.includes('Subagents of Fix routing'))
  assert(html.includes('Investigate routes'))
  assert(html.includes('OpenCode · Waiting for your answer'))
  assert(!html.includes('OpenCode · buddy'))
  assert(html.includes('Includes subagent activity'))
})

test('collapsed notch summarizes families; names and harnesses remain in expanded details', () => {
  const parent = {
    id: 'opencode:root',
    harness: 'opencode',
    name: 'Fix session counting',
    parentId: null,
    ordinal: 0,
    status: 'working',
    presence: 'observed',
    lastSeen: Date.now(),
    statusChangedAt: Date.now(),
    attention: [],
    project: 'buddy',
    dataUri: snapshot.avatarPreviews[0].dataUri,
  }
  const child = {
    ...parent,
    id: 'opencode:child',
    name: 'Audit the count',
    parentId: parent.id,
    ordinal: 1,
    status: 'needs-attention',
  }
  const current = {
    ...snapshot,
    harnesses: [{ ...harness, id: 'opencode', name: 'OpenCode' }],
    sessions: [parent, child],
    history: [],
    overlay: { expanded: false },
  }
  const html = renderToStaticMarkup(createElement(OverlaySessions, { snapshot: current }))
  assert(!html.includes('Fix session counting'))
  assert(html.includes('1 waiting for you'))
  assert(html.includes('1 sessions · 1 waiting for you. Click to open sessions.'))
  assert(!html.includes('Audit the count'))
  const expanded = renderToStaticMarkup(
    createElement(OverlaySessions, { snapshot: { ...current, overlay: { expanded: true } } }),
  )
  assert(expanded.includes('Fix session counting'))
  assert(expanded.includes('OpenCode'))
  assert(expanded.includes('1 session · 1 subagent'))
  assert(expanded.includes('+1 subagent'))
})

test('compact wings limit avatars to two and expose overflow without putting a button over the camera', () => {
  const sessions = Array.from({ length: 8 }, (_, index) => ({
    id: `codex:${index}`,
    harness: 'codex',
    name: `Task ${index}`,
    parentId: null,
    ordinal: index,
    status: 'working',
    presence: 'observed',
    lastSeen: Date.now(),
    statusChangedAt: Date.now(),
    attention: [],
    dataUri: snapshot.avatarPreviews[0].dataUri,
  }))
  const display = {
    id: 1,
    camera: { x: 650, y: 0, width: 212, height: 38 },
    auxiliaryLeft: { x: 0, y: 0, width: 650, height: 38 },
    auxiliaryRight: { x: 862, y: 0, width: 650, height: 38 },
  }
  const current = {
    ...snapshot,
    sessions,
    history: [],
    overlay: {
      expanded: false,
      anchorId: 1,
      actualBounds: { x: 596, y: 0, width: 320, height: 38 },
      displays: [display],
    },
  }
  const html = renderToStaticMarkup(createElement(OverlaySessions, { snapshot: current }))
  assert.equal((html.match(/<img /g) ?? []).length, 2)
  assert.equal((html.match(/<button /g) ?? []).length, 2)
  assert(html.includes('grid-template-columns:54px 212px minmax(0, 1fr)'))
  assert(html.includes('+6'))
  assert(html.includes('8 busy'))
  assert(html.includes('8 sessions'))
  assert(!html.includes('Task 0'))
  for (const actualBounds of [null, { x: 596, y: 44, width: 320, height: 60 }]) {
    const stale = renderToStaticMarkup(
      createElement(OverlaySessions, {
        snapshot: { ...current, overlay: { ...current.overlay, actualBounds } },
      }),
    )
    assert(
      !stale.includes('overlay-wings'),
      'Missing or old below-menu placement never draws a camera gap',
    )
    assert(!stale.includes('grid-template-columns'))
    assert.equal((stale.match(/<button /g) ?? []).length, 1)
  }
  const expanded = renderToStaticMarkup(
    createElement(OverlaySessions, {
      snapshot: { ...current, overlay: { ...current.overlay, expanded: true } },
    }),
  )
  assert.equal((expanded.match(/class="session-row"/g) ?? []).length, 8)
  assert(expanded.includes('Task 7'))
})

test('the renderer keeps only completion rows held by main while hovering', () => {
  const completed = {
    id: 'codex:completed',
    harness: 'codex',
    name: 'Finished task',
    parentId: null,
    ordinal: 0,
    status: 'completed',
    presence: 'observed',
    lastSeen: Date.now() - 20_000,
    statusChangedAt: Date.now() - 20_000,
    attention: [],
    project: 'buddy',
    activity: [],
    dataUri: snapshot.avatarPreviews[0].dataUri,
  }
  const current = { ...snapshot, sessions: [completed], history: [], overlay: { expanded: true } }
  assert.equal(renderToStaticMarkup(createElement(OverlaySessions, { snapshot: current })), '')
  const held = renderToStaticMarkup(
    createElement(OverlaySessions, {
      snapshot: {
        ...current,
        overlay: { expanded: true, completionHoldIds: [completed.id] },
      },
    }),
  )
  assert(held.includes('Finished task'))
  assert(held.includes('1 session'))
})

test('a settled failed subagent has a quiet parent badge and its own error details', () => {
  setSessionFilters(false, {
    harness: 'all',
    project: 'all',
    status: 'all',
    recent: 'all',
    search: '',
    groupBy: 'none',
  })
  const parent = {
    id: 'opencode:parent',
    providerSessionId: 'parent',
    harness: 'opencode',
    name: 'Continue implementation',
    parentId: null,
    ordinal: 0,
    status: 'working',
    presence: 'observed',
    lastSeen: Date.now(),
    statusChangedAt: Date.now(),
    turnStartedAt: Date.now() - 1000,
    turnActive: true,
    attention: [],
    project: 'buddy',
    cwd: '/projects/buddy',
    activity: [],
    dataUri: snapshot.avatarPreviews[0].dataUri,
  }
  const child = {
    ...parent,
    id: 'opencode:child',
    providerSessionId: 'child',
    name: 'Failed subtask',
    parentId: parent.id,
    ordinal: 1,
    status: 'error',
    turnActive: false,
  }
  const current = {
    ...snapshot,
    harnesses: [{ ...harness, id: 'opencode', name: 'OpenCode' }],
    sessions: [parent, child],
    history: [],
    overlay: { expanded: false },
  }
  const html = renderToStaticMarkup(createElement(SessionList, { snapshot: current }))
  assert(html.includes('+1 subagent · 1 failed'))
  assert(html.includes('Turn ended with an error · Agent is idle'))
  assert(
    !html.match(/<div[^>]*class="[^"]*session-card[^"]*"[^>]*>/)[0].includes('data-signal="error"'),
    'Parent row stays neutral',
  )
  const notch = renderToStaticMarkup(createElement(OverlaySessions, { snapshot: current }))
  assert(notch.includes('1 working'))
  assert(!notch.includes('data-signal="error"'))
})

test('opening a family selects its pending request owner across all harnesses and ignores ended descendants', () => {
  for (const id of ['codex', 'claude-code', 'opencode']) {
    const parent = {
      id: `${id}:parent`,
      harness: id,
      parentId: null,
      ordinal: 0,
      status: 'working',
      presence: 'observed',
      lastSeen: Date.now(),
      statusChangedAt: Date.now(),
      attention: [],
    }
    const child = { ...parent, id: `${id}:child`, parentId: parent.id, ordinal: 1 }
    const nested = {
      ...parent,
      id: `${id}:nested`,
      parentId: child.id,
      ordinal: 2,
      status: 'needs-attention',
    }
    const ended = {
      ...parent,
      id: `${id}:ended`,
      parentId: parent.id,
      ordinal: 3,
      presence: 'closed',
      status: 'needs-attention',
    }
    const family = sessionFamilies([parent, child, nested], [parent, child, nested, ended])[0]
    assert.equal(familyInputSession(family).id, nested.id)
    assert.equal(
      familyInputSession(family, [
        { sessionId: ended.id, createdAt: 0 },
        { sessionId: child.id, createdAt: 2 },
        { sessionId: nested.id, createdAt: 1 },
      ]).id,
      nested.id,
    )
    assert.equal(familyInputSession(family, [{ sessionId: parent.id, createdAt: 1 }]).id, parent.id)
  }
})

test('dashboard opens the child question and shows its answer controls before project actions', () => {
  const parent = {
    id: 'opencode:parent',
    harness: 'opencode',
    name: 'Fix routing',
    parentId: null,
    ordinal: 0,
    status: 'working',
    presence: 'observed',
    lastSeen: Date.now(),
    statusChangedAt: Date.now(),
    attention: [],
    activity: [],
    cwd: '/projects/buddy',
    project: 'buddy',
    dataUri: snapshot.avatarPreviews[0].dataUri,
  }
  const child = {
    ...parent,
    id: 'opencode:child',
    name: 'Choose deployment target',
    parentId: parent.id,
    ordinal: 1,
    status: 'needs-attention',
    attention: [{ id: 'question', kind: 'question', tool: null }],
  }
  const html = renderToStaticMarkup(
    createElement(SessionList, {
      snapshot: {
        ...snapshot,
        harnesses: [{ ...harness, id: 'opencode', name: 'OpenCode', controls: true }],
        sessions: [parent, child],
        history: [],
        requests: [
          {
            id: 'question',
            sessionId: child.id,
            kind: 'question',
            questions: [
              {
                text: 'Confirm deployment?',
                options: [
                  { label: 'Yes', description: '' },
                  { label: 'No', description: '' },
                ],
              },
            ],
          },
        ],
      },
    }),
  )
  assert(html.includes('Confirm deployment?'))
  assert(html.includes('Send answers'))
  assert(html.indexOf('Confirm deployment?') < html.indexOf('Reveal project'))
  assert(html.includes('View parent session'))
})

test('attention without a request payload explains missing details instead of offering a fake question', () => {
  const session = {
    id: 'opencode:question',
    harness: 'opencode',
    status: 'needs-attention',
    presence: 'observed',
    attention: [{ id: 'question', kind: 'question' }],
  }
  const current = {
    ...snapshot,
    harnesses: [{ ...harness, id: 'opencode', name: 'OpenCode', controls: true }],
    requests: [],
  }
  const html = renderToStaticMarkup(createElement(SessionRequests, { session, snapshot: current }))
  assert(html.includes('Question awaiting your answer'))
  assert(html.includes('request details haven’t reached Buddy'))
  assert(html.includes('restart OpenCode once'))
  assert(!html.includes('Send answers'))
  for (const presence of ['closed', 'stale'])
    assert.equal(
      renderToStaticMarkup(
        createElement(SessionRequests, {
          session: { ...session, presence },
          snapshot: current,
        }),
      ),
      '',
      'Historical attention does not claim a question is still awaiting an answer',
    )
  const codex = renderToStaticMarkup(
    createElement(SessionRequests, {
      session: { ...session, harness: 'codex' },
      snapshot,
    }),
  )
  assert(codex.includes('Native replies aren’t connected to this session'))
  assert(!codex.includes('restart Codex'))
  const subagent = renderToStaticMarkup(
    createElement(SessionRequests, {
      session: { ...session, harness: 'claude-code', parentId: 'claude-code:parent' },
      snapshot: { ...current, harnesses: [{ ...harness, id: 'claude-code', controls: true }] },
    }),
  )
  assert(subagent.includes('Answer in Claude Code'))
  assert(!subagent.includes('restart'))
})

test('pagination groups the whole result and marks continuing days, keyboard movement crosses pages', () => {
  const records = Array.from({ length: 23 }, (_, i) => ({
    id: String(i),
    project: i < 15 ? 'Today' : 'Yesterday',
  }))
  const group = (record) => ({ key: record.project, label: record.project })
  const first = sessionPage(records, group, 0)
  const second = sessionPage(records, group, 1)
  assert.equal(first.groups.get('Today').label, 'Today')
  assert.equal(second.groups.get('Today').label, 'Today (continued)')
  assert.equal(second.groups.get('Today').items.length, 5)
  assert.equal(second.groups.get('Yesterday').label, 'Yesterday')
  assert.equal(nextSessionRow(second.ordered, '9', 'ArrowDown').id, '10')
  assert.equal(nextSessionRow(second.ordered, '10', 'ArrowUp').id, '9')
  assert.equal(nextSessionRow(second.ordered, '4', 'End').id, '22')
  assert.equal(nextSessionRow(second.ordered, '4', 'Home').id, '0')
  assert.equal(nextSessionRow(second.ordered, '0', 'ArrowUp'), undefined)
  const interleaved = [records[0], records[15], records[1], records[16]]
  const grouped = sessionPage(interleaved, group, 0, 2)
  assert.deepEqual(
    grouped.ordered.map((record) => record.id),
    ['0', '1', '15', '16'],
  )
  assert.equal(nextSessionRow(grouped.ordered, '1', 'ArrowDown').id, '15')
})
