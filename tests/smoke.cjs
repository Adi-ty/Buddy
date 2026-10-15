const assert = require('node:assert/strict')
const { mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { dirname, resolve, join } = require('node:path')
const {
  app,
  clipboard,
  dialog,
  nativeTheme,
  powerMonitor,
  screen,
  safeStorage,
} = require('electron')

if (process.platform !== 'darwin') {
  console.error('The native smoke test requires macOS and a graphical login session.')
  app.exit(1)
}

// A separate profile keeps test events out of the user's session history.
const artifacts = resolve('.cache/smoke')
mkdirSync(artifacts, { recursive: true })
const profile = process.env.BUDDY_SMOKE_PROFILE
if (!profile || dirname(profile) !== artifacts) {
  console.error('Run smoke tests with npm run test:smoke.')
  app.exit(1)
}
// Observer actions exercise real writes, scoped to disposable harness configs.
process.env.CODEX_HOME = join(profile, 'codex')
process.env.CLAUDE_CONFIG_DIR = join(profile, 'claude')
process.env.OPENCODE_CONFIG_DIR = join(profile, 'opencode')
process.env.XDG_CONFIG_HOME = join(profile, 'config')
process.env.XDG_DATA_HOME = join(profile, 'data')
process.env.XDG_STATE_HOME = join(profile, 'state')
delete process.env.ELECTRON_RENDERER_URL
// CLI fixtures only exercise Buddy's setup/detection contracts. Compatibility
// with actual installed harness versions is a separate integration check.
const bin = join(profile, 'bin')
mkdirSync(bin)
for (const [command, version] of [
  ['codex', '0.162.1'],
  ['claude', '2.1.295'],
  ['opencode', '2.0.29'],
]) {
  writeFileSync(
    join(bin, command),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\nif [ "$1" = "features" ] && [ "$2" = "list" ]; then echo 'hooks stable true'; exit 0; fi\nexit 1\n`,
    { mode: 0o700 },
  )
}
process.env.PATH = `${bin}:${process.env.PATH ?? ''}`
// Do not deliver native notifications while exercising synthetic events.
writeFileSync(join(profile, 'settings.json'), JSON.stringify({ desktopNotifications: false }))
for (const path of [
  process.env.CODEX_HOME,
  process.env.CLAUDE_CONFIG_DIR,
  process.env.OPENCODE_CONFIG_DIR,
  process.env.XDG_CONFIG_HOME,
  process.env.XDG_DATA_HOME,
  process.env.XDG_STATE_HOME,
])
  mkdirSync(path, { recursive: true })
writeFileSync(
  join(process.env.CODEX_HOME, 'session_index.jsonl'),
  Array.from({ length: 8 }, (_, i) =>
    JSON.stringify({ id: `test-session-${i}`, thread_name: `Codex task ${i + 1}` }),
  ).join('\n') + '\n',
)
const setPath = app.setPath.bind(app)
app.setPath = (name, path) =>
  setPath(name, ['userData', 'sessionData'].includes(name) ? profile : path)
process.argv.push('--dashboard')
const windows = []
const errors = []
const cleanups = []
let stopping = false
app.on('browser-window-created', (_event, window) => {
  windows.push(window)
  // Avoid activating test windows. Real focus/Spaces behavior needs a manual
  // macOS check; isFocusable assertions cover Buddy's focus policy.
  window.show = () => window.showInactive()
  window.focus = () => {}
  window.webContents.setBackgroundThrottling(false)
  window.webContents.on('preload-error', (_event, _path, error) => errors.push(error.message))
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error') errors.push(details.message)
  })
})
const telegramFixture = require('./telegram-smoke.cjs')(safeStorage)
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
let pointer = { x: -10000, y: -10000 }
app.once('ready', () => {
  // Programmatic clicks do not move the real pointer. Control the pointer
  // fixture so interactions cannot race the production leave-to-collapse timer.
  screen.getCursorScreenPoint = () => pointer
})
async function until(check, label) {
  const deadline = Date.now() + 7000
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await wait(80)
  }
  throw new Error(`Timed out: ${label}`)
}
const js = async (window, code) => {
  try {
    return await window.webContents.executeJavaScript(code)
  } catch (error) {
    console.error('Failed renderer check:', code)
    throw error
  }
}
async function rejectsCompanionMove(window, action) {
  const message = 'Invalid companion movement request'
  const logError = console.error
  // Electron logs rejected invokes even when the rejection is expected by a test.
  console.error = (...args) => {
    if (
      args[0] === "Error occurred in handler for 'buddy:move-companion':" &&
      args[1] instanceof Error &&
      args[1].message === message
    )
      return
    logError(...args)
  }
  try {
    await assert.rejects(
      window.webContents.executeJavaScript(`window.buddy.moveCompanion(${JSON.stringify(action)})`),
      /Error invoking remote method 'buddy:move-companion': Error: Invalid companion movement request/,
    )
  } finally {
    console.error = logError
  }
}
const snapshot = (window) => js(window, 'window.buddy.getSnapshot()')
const waitForSelector = (window, selector) =>
  until(
    () => js(window, `Boolean(document.querySelector(${JSON.stringify(selector)}))`),
    `rendered ${selector}`,
  )
const clickSelector = (window, selector) =>
  until(
    () =>
      js(
        window,
        `(() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!element || element.matches(':disabled') || !element.getClientRects().length) return false;
          element.click();
          return true;
        })()`,
      ),
    `clickable ${selector}`,
  )
const click = (window, text) =>
  js(
    window,
    `(() => {
  const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === ${JSON.stringify(text)});
  if (!button || button.disabled) throw new Error('Missing or disabled button: ' + ${JSON.stringify(text)});
  button.click();
})()`,
  )
const select = (window, label, value) =>
  js(
    window,
    `(() => {
  const select = document.querySelector('select[aria-label=${JSON.stringify(label)}]');
  if (!select || select.disabled || ![...select.options].some(option => option.value === ${JSON.stringify(value)}))
    throw new Error('Missing or disabled select option: ' + ${JSON.stringify(label)});
  select.value = ${JSON.stringify(value)};
  select.dispatchEvent(new Event('change', { bubbles: true }));
})()`,
  )
const rowText = (window) =>
  js(window, '[...document.querySelectorAll(".session-row")].map(row => row.textContent)')
const expand = async (window) => {
  const bounds = window.getBounds()
  pointer = { x: bounds.x + 20, y: bounds.y + 20 }
  await js(window, 'document.querySelector(".overlay-compact button[aria-expanded]")?.click()')
  await until(
    () => js(window, 'document.querySelectorAll(".session-row").length > 0'),
    'expanded companion rows',
  )
}
const overlayDetailsVisible = (window, id) =>
  js(
    window,
    `(() => {
    const row = [...document.querySelectorAll('.session-row')].find(row => row.dataset.sessionId === ${JSON.stringify(id)});
    return Boolean(row && row.getAttribute('aria-expanded') === 'true' && !row.hasAttribute('aria-pressed')
      && row.closest('.session-card')?.querySelector(':scope > .session-row-details'));
  })()`,
  )
const openOverlayRow = async (window, id) => {
  await js(
    window,
    `(() => {
    const row = [...document.querySelectorAll('.session-row')].find(row => row.dataset.sessionId === ${JSON.stringify(id)});
    if (!row || !row.hasAttribute('aria-expanded') || row.hasAttribute('aria-pressed'))
      throw new Error('Missing overlay disclosure row: ' + ${JSON.stringify(id)});
    if (row.getAttribute('aria-expanded') !== 'true') row.click();
  })()`,
  )
  await until(() => overlayDetailsVisible(window, id), `details inside overlay card ${id}`)
}
const timeout = setTimeout(() => {
  if (stopping) {
    console.error('Electron did not finish quitting')
    app.exit(1)
    return
  }
  void fail(new Error('Smoke test exceeded 90 seconds'))
}, 90000)

async function verify() {
  const dashboard = await until(
    () => windows.find((window) => window.webContents.getURL() === 'buddy://app/index.html'),
    'dashboard window',
  )
  await until(
    () => js(dashboard, 'document.querySelector("h1")?.textContent === "Sessions"'),
    'dashboard render',
  )
  await until(async () => (await snapshot(dashboard)).tracking.available, 'tracking bridge')
  assert.equal((await snapshot(dashboard)).sessions.length, 0)
  assert.equal(await js(dashboard, 'typeof window.buddy.setOverlayPreview'), 'undefined')
  await js(dashboard, 'document.querySelector(".skip-link").click()')
  assert.equal(await js(dashboard, 'location.hash'), '')
  assert.equal(await js(dashboard, 'document.activeElement.id'), 'main-content')
  assert((await snapshot(dashboard)).tracking.available, 'Skip link keeps IPC trusted')
  const preferences = dashboard.webContents.getLastWebPreferences()
  assert.equal(preferences.contextIsolation, true)
  assert.equal(preferences.nodeIntegration, false)
  assert.equal(preferences.sandbox, true)
  assert.equal(await js(dashboard, 'typeof window.require'), 'undefined')
  const { report } = await import('../integrations/reporter.mjs')
  const { connectControls } = await import('../integrations/control-client.mjs')
  const { codexFixture } = await import('./codex-fixture.mjs')
  const send = async (event, sessionId, extra = {}) => {
    await report(join(profile, 'bridge.json'), {
      harness: 'codex',
      event,
      sessionId,
      cwd: '/projects/buddy',
      ...extra,
    })
  }
  for (let i = 0; i < 8; i++) await send('SessionStart', `test-session-${i}`)
  await until(async () => (await snapshot(dashboard)).sessions.length === 8, 'eight hook sessions')
  await until(
    async () => (await snapshot(dashboard)).overlay.visible,
    'native companion visibility',
  )
  const overlay = windows.find((window) => window.webContents.getURL().endsWith('#overlay'))
  assert(overlay)
  assert.equal(overlay.isFocusable(), false)
  await until(
    () => js(overlay, 'document.body.textContent.includes("8 sessions")'),
    'compact live session count',
  )
  const bounds = overlay.getBounds()
  const placement = (await snapshot(dashboard)).overlay
  const display = placement.displays.find((item) => item.id === placement.anchorId)
  assert(bounds.y >= display.workArea.y)
  assert(
    bounds.x >= display.workArea.x &&
      bounds.x + bounds.width <= display.workArea.x + display.workArea.width,
  )
  assert(bounds.y + bounds.height <= display.workArea.y + display.workArea.height)
  const compact = overlay.getBounds()
  assert(await js(overlay, '!!document.querySelector("button.companion-handle")'))
  await rejectsCompanionMove(dashboard, 'start')
  await rejectsCompanionMove(overlay, 'teleport')
  pointer = { x: compact.x + 20, y: compact.y + 20 }
  await js(overlay, "window.buddy.moveCompanion('start')")
  pointer = { x: compact.x - 80, y: compact.y - 80 }
  await js(overlay, "window.buddy.moveCompanion('finish')")
  const moved = overlay.getBounds()
  assert.equal(moved.x, compact.x - 100)
  assert.equal(moved.y, compact.y - 100)
  assert.equal(overlay.isFocusable(), false, 'Dragging leaves the agent window focused')
  assert(JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')).companionPosition)
  await expand(overlay)
  const enlarged = overlay.getBounds()
  assert(enlarged.x >= display.workArea.x && enlarged.y >= display.workArea.y)
  assert(enlarged.x + enlarged.width <= display.workArea.x + display.workArea.width)
  assert(enlarged.y + enlarged.height <= display.workArea.y + display.workArea.height)
  await js(overlay, `document.querySelector('button[aria-label="Collapse sessions"]').click()`)
  await until(async () => !(await snapshot(dashboard)).overlay.expanded, 'collapse after moving')
  assert.deepEqual(overlay.getBounds(), moved, 'Collapse restores the compact position')
  await send('PermissionRequest', 'test-session-7', { tool: 'Bash' })
  await until(
    () => js(overlay, 'document.querySelector(".overlay-surface")?.dataset.signal === "attention"'),
    'uncorrelated permission hint',
  )
  await send('PreToolUse', 'test-session-7', { tool: 'Read', requestId: 'next-tool-call' })
  await until(
    () => js(overlay, 'document.querySelector(".overlay-surface")?.dataset.signal !== "attention"'),
    'approval hint clears when agent resumes',
  )
  await send('PermissionRequest', 'test-session-7', { requestId: 'request-1', tool: 'Bash' })
  await until(
    () => js(overlay, 'document.querySelector(".overlay-surface")?.dataset.signal === "attention"'),
    'yellow companion signal',
  )
  await expand(overlay)
  await until(
    () => js(overlay, 'document.querySelectorAll(".session-row").length === 8'),
    'all sessions in expanded companion',
  )
  assert(
    (await js(overlay, 'document.querySelector(".session-row").textContent')).includes(
      'Permission for Bash',
    ),
    'Overflowed attention is the first row',
  )
  assert(
    (await rowText(overlay)).every((text) => /Codex task \d/.test(text)),
    'Companion uses harness titles, not the project name',
  )
  assert(
    await js(
      overlay,
      `[...document.querySelectorAll('.session-row')].every(row => row.getAttribute('aria-expanded') === 'false' && !row.hasAttribute('aria-pressed'))`,
    ),
    'Closed companion rows expose disclosure state rather than selection state',
  )
  await openOverlayRow(overlay, 'codex:test-session-7')
  assert.equal(
    await js(overlay, 'document.querySelectorAll(".session-row[aria-expanded=true]").length'),
    1,
  )
  pointer = { x: -10000, y: -10000 }
  await until(
    async () => !(await snapshot(dashboard)).overlay.expanded,
    'Leaving the companion collapses it',
  )
  await until(
    async () => !(await overlayDetailsVisible(overlay, 'codex:test-session-7')),
    'Collapsed companion unmounts session details',
  )
  await expand(overlay)
  await openOverlayRow(overlay, 'codex:test-session-7')
  await send('PostToolUse', 'test-session-7', { requestId: 'request-1', tool: 'Bash' })
  await send('Stop', 'test-session-7')
  await until(
    () => js(overlay, 'document.querySelector(".overlay-surface")?.dataset.signal === "success"'),
    'green completion signal',
  )
  assert(
    (await snapshot(dashboard)).sessions.find((item) => item.providerSessionId === 'test-session-7')
      .status === 'completed',
  )
  await report(join(profile, 'bridge.json'), {
    harness: 'claude-code',
    event: 'PostToolUseFailure',
    sessionId: 'test-error',
    tool: 'Bash',
    cwd: '/projects/api',
  })
  await until(
    () => js(overlay, 'document.querySelector(".overlay-surface")?.dataset.signal === "error"'),
    'red error signal',
  )
  await report(join(profile, 'bridge.json'), {
    harness: 'opencode',
    event: 'session.updated',
    sessionId: 'test-titled',
    title: 'Fix login redirects',
    cwd: '/projects/buddy',
  })
  await report(join(profile, 'bridge.json'), {
    harness: 'opencode',
    event: 'session.status',
    sessionId: 'test-titled',
    status: 'busy',
    cwd: '/projects/buddy',
  })
  await until(
    () =>
      js(
        dashboard,
        'Array.from(document.querySelectorAll(".session-row")).some(row => row.textContent.includes("Fix login redirects"))',
      ),
    'harness session title',
  )
  await expand(overlay)
  await until(
    async () => (await rowText(overlay)).some((text) => text.includes('Fix login redirects')),
    'OpenCode title also reaches companion',
  )
  await report(join(profile, 'bridge.json'), {
    harness: 'opencode',
    event: 'session.idle',
    sessionId: 'late-completion',
    cwd: '/projects/api',
  })
  await until(
    async () =>
      (await snapshot(dashboard)).sessions.some(
        (item) => item.providerSessionId === 'late-completion' && item.status === 'completed',
      ),
    'completion without previous busy event',
  )
  // More than one dashboard page, including distinct projects and agents.
  for (let i = 8; i < 12; i++)
    await send('SessionStart', `test-session-${i}`, { cwd: '/projects/api' })
  await until(
    () => js(dashboard, 'document.body.textContent.includes("1 / 2")'),
    'dashboard pagination',
  )
  await click(dashboard, 'Next')
  await until(() => js(dashboard, 'document.body.textContent.includes("2 / 2")'), 'next page')
  assert.equal(
    await js(
      dashboard,
      'document.querySelector(".session-inspector h2").textContent === document.querySelector(".session-row .font-medium[title]").textContent',
    ),
    true,
    'Inspector follows visible page',
  )
  await click(dashboard, 'Previous')
  await js(
    dashboard,
    `document.querySelector('.session-status-filter[data-status="working"]').click()`,
  )
  await until(
    () =>
      js(
        dashboard,
        'document.querySelector(\'select[aria-label="Filter by status"]\').value === "working"',
      ),
    'working total is a real filter',
  )
  assert((await rowText(dashboard)).every((text) => text.includes('Working')))
  await js(dashboard, `document.querySelector('.session-status-filter[data-status="all"]').click()`)
  await select(dashboard, 'Filter by agent', 'codex')
  await select(dashboard, 'Filter by project', '/projects/api')
  await until(
    async () => (await rowText(dashboard)).length === 4,
    'combined live agent and project filters',
  )
  assert.equal(
    await js(
      dashboard,
      `document.querySelector('.session-status-filter[data-status="all"] strong').textContent`,
    ),
    '4',
    'Quick counts respect agent and project filters',
  )
  const searchedName = await js(
    dashboard,
    'document.querySelector(".session-row .font-medium[title]").textContent',
  )
  await js(
    dashboard,
    `(() => { const search = document.querySelector('input[aria-label="Search sessions"]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(search, ${JSON.stringify(searchedName)}); search.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  )
  await until(async () => (await rowText(dashboard)).length === 1, 'live name search')
  await js(
    dashboard,
    `(() => { const search = document.querySelector('input[aria-label="Search sessions"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, ''); search.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  )
  await select(dashboard, 'Filter by status', 'error')
  await until(async () => (await rowText(dashboard)).length === 0, 'status filter empty result')
  await click(dashboard, 'Clear filters')
  await click(dashboard, 'More filters')
  await select(dashboard, 'Filter by activity', '300000')
  await select(dashboard, 'Group sessions', 'harness')
  assert(
    await js(dashboard, 'document.querySelectorAll("h3").length > 0'),
    'Grouping shows headings',
  )
  await select(dashboard, 'Group sessions', 'project')
  await select(dashboard, 'Group sessions', 'status')
  await select(dashboard, 'Group sessions', 'none')
  await click(dashboard, 'Clear filters')
  await js(dashboard, 'document.querySelector(".session-row").click()')
  await js(dashboard, 'document.querySelector(".session-inspector summary").click()')
  assert(await js(dashboard, 'document.querySelector(".session-inspector details").open'))
  await js(dashboard, `document.querySelector('a[href="/settings"]').click()`)
  await until(
    () => js(dashboard, 'document.querySelector("h1").textContent === "Settings"'),
    'settings page',
  )
  await js(dashboard, `document.querySelector('input[type=checkbox]').click()`)
  await until(
    async () => (await snapshot(dashboard)).preferences.desktopNotifications === true,
    'notification preference saves',
  )
  await js(dashboard, `document.querySelector('input[type=checkbox]').click()`)
  await until(
    async () => (await snapshot(dashboard)).preferences.desktopNotifications === false,
    'notification preference restores',
  )
  assert(
    await js(dashboard, `document.querySelectorAll('input[type=checkbox]')[1].disabled`),
    'Login preference explains unavailable development support',
  )
  await js(dashboard, 'window.buddy.resetCompanionPosition()')
  await until(
    async () => (await snapshot(dashboard)).overlay.geometry === 'ready',
    'refresh placement',
  )
  await js(dashboard, `document.querySelector('a[href="/sessions"]').click()`)
  await until(
    () => js(dashboard, 'document.querySelector("h1").textContent === "Sessions"'),
    'return to sessions',
  )
  for (const theme of ['dark', 'light']) {
    nativeTheme.themeSource = theme
    await until(
      () => js(dashboard, `matchMedia('(prefers-color-scheme: ${theme})').matches`),
      `${theme} theme applied`,
    )
    assert((await js(dashboard, 'document.querySelectorAll(".session-row").length')) > 0)
  }
  nativeTheme.themeSource = 'system'
  await click(dashboard, 'Manage integrations')
  await until(
    () => js(dashboard, 'document.querySelector("h1")?.textContent === "Integrations"'),
    'integrations route',
  )
  await click(dashboard, 'Refresh')
  await until(
    () => js(dashboard, 'document.body.textContent.includes("Integrations refreshed.")'),
    'refresh feedback',
  )
  await waitForSelector(dashboard, 'section[aria-label="Telegram companion"]')
  assert.equal((await snapshot(dashboard)).telegram.state, 'disconnected')
  const telegramUI = 'section[aria-label="Telegram companion"]'
  const captureTelegram = async (name) => {
    if (!process.env.BUDDY_SMOKE_SCREENSHOTS) return
    await js(
      dashboard,
      `document.querySelector(${JSON.stringify(telegramUI)}).scrollIntoView({ block: 'start' })`,
    )
    await wait(150)
    writeFileSync(
      join(artifacts, `telegram-${name}.png`),
      (await dashboard.webContents.capturePage()).toPNG(),
    )
  }
  assert.equal(
    await js(dashboard, `document.querySelectorAll('${telegramUI} [role="switch"]').length`),
    0,
  )
  await captureTelegram('setup')
  await js(
    dashboard,
    `document.querySelector('input[type="password"]').value = ${JSON.stringify(telegramFixture.token)}`,
  )
  await click(dashboard, 'Connect bot')
  await until(
    async () => (await snapshot(dashboard)).telegram.state === 'pairing',
    'Telegram bot validation',
  )
  assert.equal(
    await js(dashboard, `document.querySelector('input[type="password"]')?.value ?? ""`),
    '',
  )
  await waitForSelector(dashboard, 'input[aria-label="Telegram pairing link"]')
  let pairingLink = await js(
    dashboard,
    `document.querySelector('input[aria-label="Telegram pairing link"]').value`,
  )
  await captureTelegram('pairing')
  // Exercise expiry in the renderer without altering the main-process clock.
  await js(
    dashboard,
    `window.smokeOriginalNow = Date.now; Date.now = () => window.smokeOriginalNow() + 301000; void 0`,
  )
  await until(
    () =>
      js(
        dashboard,
        `document.querySelector('${telegramUI}').textContent.includes('Link expired.')`,
      ),
    'expired pairing link feedback',
  )
  assert.equal(
    await js(dashboard, `document.querySelector('input[aria-label="Telegram pairing link"]')`),
    null,
  )
  await captureTelegram('expired')
  await js(dashboard, `Date.now = window.smokeOriginalNow; delete window.smokeOriginalNow`)
  await click(dashboard, 'Generate pairing link')
  await waitForSelector(dashboard, 'input[aria-label="Telegram pairing link"]')
  const replacedLink = await js(
    dashboard,
    `document.querySelector('input[aria-label="Telegram pairing link"]').value`,
  )
  assert.notEqual(replacedLink, pairingLink)
  // Exercise the real preload/IPC path and browser permission policy. Stub only
  // the final OS write so the user's actual clipboard stays unchanged.
  const nativeWriteText = clipboard.writeText
  let copiedLink = null
  try {
    clipboard.writeText = () => {
      throw new Error('Smoke clipboard unavailable')
    }
    await click(dashboard, 'Copy link')
    await until(
      () =>
        js(
          dashboard,
          `document.querySelector('${telegramUI}').textContent.includes('Couldn’t copy the link.')`,
        ),
      'clipboard failure feedback',
    )
    clipboard.writeText = (text) => {
      copiedLink = text
    }
    await click(dashboard, 'Copy link')
    await until(
      () => js(dashboard, `document.querySelector('${telegramUI}').textContent.includes('Copied')`),
      'native clipboard copy feedback',
    )
    assert.equal(copiedLink, replacedLink)
    assert.equal(
      await js(
        dashboard,
        `document.querySelector('${telegramUI}').textContent.includes('Couldn’t copy the link.')`,
      ),
      false,
    )
  } finally {
    clipboard.writeText = nativeWriteText
  }
  // Revisiting setup must offer a fresh link, never resurrect one from storage.
  await js(dashboard, `document.querySelector('a[href="/sessions"]').click()`)
  await click(dashboard, 'Manage integrations')
  await waitForSelector(dashboard, telegramUI)
  await click(dashboard, 'Generate pairing link')
  await waitForSelector(dashboard, 'input[aria-label="Telegram pairing link"]')
  pairingLink = await js(
    dashboard,
    `document.querySelector('input[aria-label="Telegram pairing link"]').value`,
  )
  assert.notEqual(pairingLink, replacedLink)
  telegramFixture.pair(pairingLink)
  await until(
    async () => (await snapshot(dashboard)).telegram.state === 'connected',
    'Telegram private chat pairing',
  )
  assert.match((await snapshot(dashboard)).telegram.pairedUser, /456/)
  await until(
    () => js(dashboard, `document.querySelectorAll('${telegramUI} [role="switch"]').length === 4`),
    'paired notification settings',
  )
  assert.equal(
    await js(dashboard, `document.querySelector('input[aria-label="Telegram pairing link"]')`),
    null,
  )
  await captureTelegram('connected')
  if (process.env.BUDDY_SMOKE_SCREENSHOTS) {
    const bounds = dashboard.getBounds()
    dashboard.setSize(860, 780)
    nativeTheme.themeSource = 'light'
    await until(
      () => js(dashboard, `matchMedia('(prefers-color-scheme: light)').matches`),
      'Telegram light theme',
    )
    await captureTelegram('connected-light-narrow')
    assert(
      await js(
        dashboard,
        `(() => { const card = document.querySelector('${telegramUI}'); return card.scrollWidth <= card.clientWidth })()`,
      ),
      'Telegram card fits the minimum window width',
    )
    dashboard.setBounds(bounds)
    nativeTheme.themeSource = 'system'
  }
  await click(dashboard, 'Pause notifications')
  await until(
    () =>
      js(
        dashboard,
        `document.querySelector('${telegramUI}').textContent.includes('New notifications are paused.')`,
      ),
    'pause feedback',
  )
  await captureTelegram('paused')
  await click(dashboard, 'Resume notifications')
  await until(
    async () => !(await snapshot(dashboard)).telegram.preferences.paused,
    'resume notifications',
  )
  await js(dashboard, `document.querySelector('${telegramUI} [role="switch"]').click()`)
  await until(
    async () => !(await snapshot(dashboard)).telegram.preferences.permissions,
    'category toggle saves',
  )
  assert(!JSON.stringify(await snapshot(dashboard)).includes(telegramFixture.token))
  assert(!readFileSync(join(profile, 'telegram.json'), 'utf8').includes(telegramFixture.token))
  assert(!readFileSync(join(profile, 'telegram-token.enc'), 'utf8').includes(telegramFixture.token))
  await js(
    dashboard,
    'window.buddy.setTelegramPreferences({ permissions: true, questions: true, completions: false, failures: false, paused: true })',
  )
  const originalError = console.error
  console.error = (...args) => {
    if (
      String(args[0]).includes('buddy:telegram-') &&
      args[1]?.message === 'Untrusted Buddy request'
    )
      return
    originalError(...args)
  }
  try {
    await assert.rejects(
      overlay.webContents.executeJavaScript(
        `window.buddy.copyTelegramPairingLink(${JSON.stringify(pairingLink)})`,
      ),
      /Untrusted Buddy request/,
    )
    await assert.rejects(
      overlay.webContents.executeJavaScript('window.buddy.disconnectTelegram()'),
      /Untrusted Buddy request/,
    )
  } finally {
    console.error = originalError
  }
  assert.equal((await snapshot(dashboard)).telegram.state, 'connected')
  // Exercise the real preload/IPC/settings path with a controlled native file
  // picker. No developer installations or shell profiles are modified.
  const showOpenDialog = dialog.showOpenDialog
  try {
    for (const harness of (await snapshot(dashboard)).harnesses) {
      const command = harness.id === 'claude-code' ? 'claude' : harness.id
      const custom = join(profile, `custom ${command}`)
      writeFileSync(custom, readFileSync(join(bin, command)), { mode: 0o700 })
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [custom] })
      await js(dashboard, `window.buddy.chooseExecutable(${JSON.stringify(harness.id)})`)
      let current = (await snapshot(dashboard)).harnesses.find((item) => item.id === harness.id)
      assert.equal(current.executablePath, custom)
      assert.equal(current.executableOverride, true)
      assert.equal(current.canInstall, true)
      assert.equal(
        JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')).executables[harness.id],
        custom,
      )
      await until(
        () => js(dashboard, `document.body.textContent.includes(${JSON.stringify(custom)})`),
        'chosen executable is visible',
      )

      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
      await js(dashboard, `window.buddy.chooseExecutable(${JSON.stringify(harness.id)})`)
      assert.equal(
        (await snapshot(dashboard)).harnesses.find((item) => item.id === harness.id).executablePath,
        custom,
      )
      rmSync(custom)
      await js(dashboard, 'window.buddy.refreshIntegrations()')
      current = (await snapshot(dashboard)).harnesses.find((item) => item.id === harness.id)
      assert.equal(current.installation, 'broken')
      assert.equal(current.canInstall, false)
      assert.equal(
        current.executablePath,
        custom,
        'missing override never silently switches installations',
      )
      await until(
        () => js(dashboard, 'document.body.textContent.includes("CLI could not run")'),
        'missing executable feedback',
      )
      await js(dashboard, `window.buddy.chooseExecutable(${JSON.stringify(harness.id)}, true)`)
      current = (await snapshot(dashboard)).harnesses.find((item) => item.id === harness.id)
      assert.equal(current.executablePath, join(bin, command))
      assert.equal(current.executableOverride, false)
      assert.equal(current.canInstall, true)
    }
  } finally {
    dialog.showOpenDialog = showOpenDialog
  }
  for (const harness of (await snapshot(dashboard)).harnesses) {
    assert(harness.canInstall, `CLI fixture must match the verified ${harness.name} contract`)
    await js(
      dashboard,
      `(() => {
      const section = [...document.querySelectorAll('section')].find(item => item.querySelector('h2')?.textContent === ${JSON.stringify(harness.name)});
      [...section.querySelectorAll('button')].find(button => button.textContent.includes('Install observer')).click();
    })()`,
    )
    await until(
      async () =>
        (await snapshot(dashboard)).harnesses.find((item) => item.id === harness.id).observer ===
        'installed',
      `install ${harness.name}`,
    )
    await until(
      () =>
        js(
          dashboard,
          `(() => {
      const section = [...document.querySelectorAll('section')].find(item => item.querySelector('h2')?.textContent === ${JSON.stringify(harness.name)});
      return section.textContent.includes('Observer installed') && ![...section.querySelectorAll('button')].some(button => button.textContent.includes('Install observer')) && section.textContent.includes('Remove observer');
    })()`,
        ),
      'Installed card exposes only remove',
    )
    await js(
      dashboard,
      `(() => {
      const section = [...document.querySelectorAll('section')].find(item => item.querySelector('h2')?.textContent === ${JSON.stringify(harness.name)});
      [...section.querySelectorAll('button')].find(button => button.textContent.trim() === 'Enable replies').click();
    })()`,
    )
    await until(
      async () =>
        (await snapshot(dashboard)).harnesses.find((item) => item.id === harness.id).controls ===
        true,
      `enable ${harness.name} replies`,
    )
    let ready = false
    const replies = []
    const nativeSource =
      harness.id === 'codex'
        ? await codexFixture(
            join(process.env.CODEX_HOME, 'app-server-control/app-server-control.sock'),
            'test-session-0',
          )
        : null
    const nativeClient = nativeSource ? await nativeSource.nativeClient() : null
    const channel = nativeSource
      ? null
      : connectControls(join(profile, 'controls.json'), harness.id, (message) => {
          if (message.op === 'ready') ready = message.enabled === true
          if (message.op === 'reply') {
            replies.push(message)
            channel.send({ op: 'result', id: message.id, ok: true })
          }
        })
    const closeNative = nativeSource ? () => nativeSource.close() : null
    const closeChannel = channel ? () => channel.close() : null
    if (closeNative) cleanups.push(closeNative)
    if (closeChannel) cleanups.push(closeChannel)
    if (nativeSource)
      await until(
        async () =>
          (await snapshot(dashboard)).harnesses.find((item) => item.id === 'codex')
            .controlsConnection === 'connected',
        'native Codex approval connection',
      )
    else await until(() => ready, 'control source handshake')
    const sessionId =
      harness.id === 'codex'
        ? 'test-session-0'
        : harness.id === 'claude-code'
          ? 'test-error'
          : 'test-titled'
    const permissionId = `ui-permission-${harness.id}`
    const permission = {
      op: 'request',
      id: permissionId,
      sessionId,
      hook: harness.id !== 'opencode',
      kind: 'permission',
      tool: 'Bash',
      details: '{"command":"echo smoke fixture"}',
      cwd: harness.id === 'claude-code' ? '/projects/api' : '/projects/buddy',
    }
    if (nativeSource)
      nativeSource.ask(permissionId, 'item/commandExecution/requestApproval', {
        command: 'echo smoke fixture',
        cwd: '/projects/buddy',
      })
    else channel.send(permission)
    await until(
      async () =>
        (await snapshot(dashboard)).requests?.some(
          (p) => p.sessionId === `${harness.id}:${sessionId}`,
        ),
      'approval reaches shared snapshot',
    )
    await expand(overlay)
    await openOverlayRow(overlay, `${harness.id}:${sessionId}`)
    await until(
      () =>
        js(
          overlay,
          'document.querySelector(".request-details")?.textContent.includes("echo smoke fixture")',
        ),
      'full command inside companion card',
    )
    assert.equal(
      overlay.isFocusable(),
      false,
      'Approval arrival and selection do not activate the companion',
    )
    const beforeUnlock = (await snapshot(dashboard)).sessions.map((session) => [
      session.id,
      session.status,
      session.attention,
    ])
    const beforeRequests = (await snapshot(dashboard)).requests.map((request) => request.id)
    powerMonitor.emit('lock-screen')
    powerMonitor.emit('unlock-screen')
    await until(
      async () => (await snapshot(dashboard)).overlay.geometry === 'ready',
      'unlock restores display geometry',
    )
    assert.deepEqual(
      (await snapshot(dashboard)).sessions.map((session) => [
        session.id,
        session.status,
        session.attention,
      ]),
      beforeUnlock,
      'Unlock preserves live state',
    )
    assert.deepEqual(
      (await snapshot(dashboard)).requests.map((request) => request.id),
      beforeRequests,
      'Unlock preserves exact pending requests',
    )
    powerMonitor.emit('suspend')
    powerMonitor.emit('resume')
    await until(
      async () => (await snapshot(dashboard)).overlay.geometry === 'ready',
      'wake restores display geometry',
    )
    assert.deepEqual(
      (await snapshot(dashboard)).requests.map((request) => request.id),
      beforeRequests,
      'Short sleep preserves pending requests',
    )
    await expand(overlay)
    await click(overlay, 'Allow once')
    if (nativeSource) {
      await until(
        () => nativeSource.decisions.some((p) => p.id === permissionId),
        'companion approval sent to native Codex',
      )
      assert.deepEqual(nativeSource.decisions.find((p) => p.id === permissionId).result, {
        decision: 'accept',
      })
      await until(
        () =>
          nativeClient.messages.some(
            (p) => p.method === 'serverRequest/resolved' && p.params.requestId === permissionId,
          ),
        'native Codex prompt clears after companion approval',
      )
    } else {
      await until(
        () => replies.some((p) => p.id === permissionId),
        'companion approval sent to source',
      )
      assert.deepEqual(replies.find((p) => p.id === permissionId).response, { decision: 'allow' })
    }
    await until(
      async () => !(await snapshot(dashboard)).requests?.length,
      'acknowledged approval retired',
    )
    await until(
      () => js(overlay, 'document.querySelector(".request-panel") === null'),
      'approval card clears after ack',
    )
    if (harness.id !== 'opencode')
      assert.equal(
        (await snapshot(dashboard)).sessions.find((p) => p.id === `${harness.id}:${sessionId}`)
          .status,
        'working',
        'Hook approval clears attention immediately',
      )
    if (harness.id !== 'codex') {
      const questionId = `ui-question-${harness.id}`
      channel.send({
        op: 'request',
        id: questionId,
        sessionId,
        hook: harness.id !== 'opencode',
        kind: 'question',
        tool: 'AskUserQuestion',
        details: 'Choose targets',
        questions: [
          {
            text: 'Which targets?',
            header: 'Targets',
            multiple: true,
            custom: false,
            options: [
              { label: 'Mac', description: 'Desktop' },
              { label: 'Web', description: 'Browser' },
            ],
          },
          {
            text: 'Project name?',
            header: 'Name',
            custom: true,
            options: [{ label: 'Buddy', description: '' }],
          },
        ],
      })
      await expand(overlay)
      await until(
        () => js(overlay, 'document.querySelectorAll(".question-option").length === 3'),
        'structured questions in companion',
      )
      assert.equal(
        await js(
          overlay,
          '[...document.querySelectorAll("button")].find(button => button.textContent === "Send answers").disabled',
        ),
        true,
        'No default answer is sent',
      )
      await js(
        overlay,
        `document.querySelectorAll('.question-option')[0].click(); document.querySelectorAll('.question-option')[1].click()`,
      )
      await click(overlay, 'Write your answer')
      await until(() => overlay.isFocusable(), 'deliberate text entry enables keyboard focus')
      await until(
        () => js(overlay, 'document.querySelector("textarea") !== null'),
        'custom answer field',
      )
      await js(
        overlay,
        `(() => { const input = document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Custom project'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
      )
      await until(
        () =>
          js(
            overlay,
            '[...document.querySelectorAll("button")].find(button => button.textContent === "Send answers").disabled === false',
          ),
        'custom and multi-select answers ready',
      )
      await click(overlay, 'Send answers')
      await until(() => replies.some((p) => p.id === questionId), 'question answers delivered')
      assert.deepEqual(replies.find((p) => p.id === questionId).response, {
        answers: [['Mac', 'Web'], ['Custom project']],
      })
      await until(
        async () => !(await snapshot(dashboard)).requests?.length && !overlay.isFocusable(),
        'acknowledged question releases keyboard focus',
      )
    }
    if (nativeSource) {
      const questionId = 'native-codex-question'
      nativeSource.ask(questionId, 'item/tool/requestUserInput', {
        questions: [
          {
            id: 'continue_work',
            header: 'Continue',
            question: 'Continue the native Codex task?',
            isOther: true,
            options: [
              { label: 'Yes', description: 'Continue' },
              { label: 'No', description: 'Stop' },
            ],
          },
        ],
      })
      await until(
        () =>
          js(
            overlay,
            'document.querySelector("fieldset")?.textContent.includes("Continue the native Codex task?")',
          ),
        'native Codex question inside companion',
      )
      await js(overlay, 'document.querySelector("fieldset input[type=radio]").click()')
      await click(overlay, 'Send answers')
      await until(
        () => nativeSource.decisions.some((p) => p.id === questionId),
        'Codex question answer delivered',
      )
      assert.deepEqual(nativeSource.decisions.find((p) => p.id === questionId).result, {
        answers: { continue_work: { answers: ['Yes'] } },
      })
      await until(
        async () => !(await snapshot(dashboard)).requests?.length,
        'Codex question clears both Buddy views',
      )
      const nativeFirst = 'native-codex-first'
      nativeSource.ask(nativeFirst)
      await until(
        async () =>
          (await snapshot(dashboard)).requests?.length === 1 &&
          nativeClient.messages.some((p) => p.id === nativeFirst),
        'same approval visible to Codex and Buddy',
      )
      nativeClient.respond(nativeFirst, { decision: 'accept' })
      await until(
        async () =>
          !(await snapshot(dashboard)).requests?.length &&
          (await js(overlay, 'document.querySelector(".request-panel") === null')),
        'answer in native Codex clears the companion and dashboard',
      )
    }
    if (harness.id === 'opencode') {
      await js(
        dashboard,
        'window.buddy.setTelegramPreferences({ permissions: true, questions: true, completions: false, failures: false, paused: false })',
      )
      channel.send({
        ...permission,
        id: 'telegram-smoke-permission',
        details: 'echo telegram smoke',
      })
      const remoteMessage = await until(
        () =>
          [...telegramFixture.messages.values()].find(
            (message) =>
              message.text?.includes('echo telegram smoke') &&
              message.reply_markup?.inline_keyboard?.length,
          ),
        'Telegram pending permission',
      )
      const handle = remoteMessage.reply_markup.inline_keyboard
        .flat()
        .find((button) => button.text === 'Allow once').callback_data
      telegramFixture.tap(remoteMessage, handle)
      await until(
        () => replies.some((reply) => reply.id === 'telegram-smoke-permission'),
        'Telegram answer reaches owning integration',
      )
      assert.deepEqual(replies.find((reply) => reply.id === 'telegram-smoke-permission').response, {
        decision: 'allow',
      })
      await until(
        () =>
          telegramFixture.messages
            .get(remoteMessage.message_id)
            ?.text.includes('Answered in Telegram'),
        'Telegram confirmed resolution label',
      )
      telegramFixture.tap(remoteMessage, handle)
      await wait(150)
      assert.equal(replies.filter((reply) => reply.id === 'telegram-smoke-permission').length, 1)
      await js(dashboard, 'window.buddy.disconnectTelegram()')
      await until(
        async () => (await snapshot(dashboard)).telegram.state === 'disconnected',
        'Telegram disconnect',
      )
    }
    channel?.close()
    if (closeChannel) cleanups.splice(cleanups.indexOf(closeChannel), 1)
    await js(
      dashboard,
      `(() => {
      const section = [...document.querySelectorAll('section')].find(item => item.querySelector('h2')?.textContent === ${JSON.stringify(harness.name)});
      [...section.querySelectorAll('button')].find(button => button.textContent.trim() === 'Disable replies').click();
    })()`,
    )
    await until(
      async () =>
        (await snapshot(dashboard)).harnesses.find((item) => item.id === harness.id).controls ===
        false,
      `disable ${harness.name} replies`,
    )
    if (nativeSource) {
      await nativeSource.close()
      cleanups.splice(cleanups.indexOf(closeNative), 1)
    }
    await js(
      dashboard,
      `(() => {
      const section = [...document.querySelectorAll('section')].find(item => item.querySelector('h2')?.textContent === ${JSON.stringify(harness.name)});
      [...section.querySelectorAll('button')].find(button => button.textContent.includes('Remove observer')).click();
    })()`,
    )
    assert(
      await js(dashboard, 'document.querySelector("dialog").open'),
      'Removal needs confirmation',
    )
    await js(
      dashboard,
      `document.querySelector('dialog').dispatchEvent(new Event('cancel', { cancelable: true }))`,
    )
    assert.equal(
      (await snapshot(dashboard)).harnesses.find((item) => item.id === harness.id).observer,
      'installed',
      'Cancel preserves observer',
    )
    await js(
      dashboard,
      `(() => { const section = [...document.querySelectorAll('section')].find(item => item.querySelector('h2')?.textContent === ${JSON.stringify(harness.name)}); [...section.querySelectorAll('button')].find(button => button.textContent.includes('Remove observer')).click(); })()`,
    )
    await js(
      dashboard,
      `document.querySelector('dialog button[data-slot=button]:last-child').click()`,
    )
    await until(
      async () =>
        (await snapshot(dashboard)).harnesses.find((item) => item.id === harness.id).observer ===
        'not-installed',
      `remove ${harness.name}`,
    )
  }
  await js(
    dashboard,
    '[...document.querySelectorAll("summary")].find(item => item.textContent === "What Buddy tracks").click()',
  )
  await until(
    () =>
      js(
        dashboard,
        '[...document.querySelectorAll("summary")].find(item => item.textContent === "What Buddy tracks").parentElement.open',
      ),
    'tracking disclosure opens',
  )
  await js(dashboard, `document.querySelector('a[href="/history"]').click()`)
  await until(
    () => js(dashboard, 'document.querySelector("h1")?.textContent === "History"'),
    'history route',
  )
  await expand(overlay)
  await click(overlay, 'Dashboard')
  await until(
    () => js(dashboard, 'document.querySelector("h1")?.textContent === "Sessions"'),
    'dashboard button from companion',
  )
  await js(overlay, `document.querySelector('button[aria-label="Collapse sessions"]').click()`)
  await until(
    async () => !(await snapshot(dashboard)).overlay.expanded,
    'collapse companion button',
  )
  pointer = { x: -10000, y: -10000 }
  await js(dashboard, `document.querySelector('a[href="/history"]').click()`)
  await until(
    () => js(dashboard, 'document.querySelector("h1")?.textContent === "History"'),
    'return to history',
  )
  for (let i = 0; i < 12; i++)
    await send('SessionEnd', `test-session-${i}`, {
      cwd: i >= 8 ? '/projects/api' : '/projects/buddy',
    })
  await report(join(profile, 'bridge.json'), {
    harness: 'claude-code',
    event: 'SessionEnd',
    sessionId: 'test-error',
  })
  await report(join(profile, 'bridge.json'), {
    harness: 'opencode',
    event: 'session.deleted',
    sessionId: 'test-titled',
  })
  await report(join(profile, 'bridge.json'), {
    harness: 'opencode',
    event: 'session.deleted',
    sessionId: 'late-completion',
  })
  await until(async () => !(await snapshot(dashboard)).overlay.visible, 'empty companion hidden')
  await until(async () => (await snapshot(dashboard)).history.length === 15, 'history populated')
  await select(dashboard, 'Filter by agent', 'codex')
  await until(
    () => js(dashboard, 'document.body.textContent.includes("12 of 15 past sessions")'),
    'history agent filter',
  )
  await select(dashboard, 'Filter by project', '/projects/api')
  await until(
    async () => (await rowText(dashboard)).length === 4,
    'combined history coding agent and project filters',
  )
  assert(
    await js(
      dashboard,
      `window.buddy.getSnapshot().then(snapshot => [...document.querySelectorAll('.session-row')].every(row => snapshot.history.find(session => session.id === row.dataset.sessionId)?.cwd === '/projects/api'))`,
    ),
  )
  await select(dashboard, 'Filter by agent', 'all')
  await until(async () => (await rowText(dashboard)).length === 6, 'project-only history filter')
  await select(dashboard, 'Filter by status', 'completed')
  await until(async () => (await rowText(dashboard)).length === 1, 'history finished filter')
  await click(dashboard, 'Clear filters')
  await click(dashboard, 'More filters')
  await select(dashboard, 'Filter by activity', '86400000')
  await select(dashboard, 'Group sessions', 'project')
  await report(join(profile, 'bridge.json'), {
    harness: 'codex',
    event: 'Stop',
    sessionId: 'notice-expiry',
    at: Date.now() - 11000,
  })
  await until(
    () => js(overlay, 'document.querySelector(".overlay-surface")?.dataset.signal === "success"'),
    'brief completion notice',
  )
  await until(
    () =>
      js(
        overlay,
        'document.querySelector(".overlay-surface")?.dataset.signal === undefined && !document.body.textContent.includes("1 finished")',
      ),
    'completion notice clears without source activity',
  )
  await until(
    async () => !(await snapshot(dashboard)).overlay.visible,
    'finished-only companion hides without a closing event',
  )
  assert.equal(
    (await snapshot(dashboard)).sessions[0].status,
    'completed',
    'Final status remains accurate after notification expires',
  )
  await send('SessionEnd', 'notice-expiry')
  await until(async () => !(await snapshot(dashboard)).overlay.visible, 'expiry fixture closed')

  // Exercise the installed OpenCode V2 plugin through its event subscription.
  await js(dashboard, 'window.buddy.installIntegration("opencode")')
  await js(dashboard, 'window.buddy.setIntegrationControls("opencode", true)')
  const { loadInstalledOpenCodePlugin } = await import('./opencode-host-fixture.mjs')
  const BuddyPlugin = await loadInstalledOpenCodePlugin(profile)
  const familyRoot = 'family-root'
  const familyChildren = Array.from({ length: 7 }, (_, i) => `family-child-${i}`)
  const familyInfos = new Map([
    [familyRoot, { id: familyRoot, title: 'Confirm the next step', directory: '/projects/buddy' }],
    ...familyChildren.map((id, i) => [
      id,
      {
        id,
        title: `Review ${i + 1}`,
        directory: '/projects/buddy',
        parentID: i === 6 ? familyChildren[0] : familyRoot,
      },
    ]),
  ])
  const familyForms = new Map()
  const familyAnswers = []
  const { createServer } = require('node:http')
  const service = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    let data
    if (path === '/api/session/active') data = { [familyRoot]: 'running' }
    else if (path === '/api/permission/request') data = []
    else if (path === '/api/form') data = [...familyForms.values()]
    else {
      const match = path.match(/^\/api\/session\/([^/]+)\/form\/([^/]+)(\/reply)?$/)
      const form = match && familyForms.get(match[2])
      if (!form || form.sessionID !== match[1]) {
        response.writeHead(404).end()
        return
      }
      if (match[3] && request.method === 'POST') {
        let body = ''
        for await (const chunk of request) body += chunk
        familyAnswers.push({ sessionID: match[1], formID: match[2], ...JSON.parse(body) })
        familyForms.delete(match[2])
        response.writeHead(204).end()
        return
      }
      data = { ...form, state: { status: 'pending' } }
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ data }))
  })
  await new Promise((resolve, reject) => {
    service.once('error', reject)
    service.listen(0, '127.0.0.1', resolve)
  })
  const closeService = () =>
    new Promise((resolve) => {
      service.closeAllConnections()
      service.close(resolve)
    })
  cleanups.push(closeService)
  mkdirSync(join(process.env.XDG_STATE_HOME, 'opencode'), { recursive: true })
  writeFileSync(
    join(process.env.XDG_STATE_HOME, 'opencode/service.json'),
    JSON.stringify({
      url: `http://127.0.0.1:${service.address().port}`,
      pid: process.pid,
    }),
  )
  const eventQueue = []
  let wakeEvent = () => {}
  const pluginCleanup = BuddyPlugin.setup({
    location: { directory: '/projects/buddy' },
    session: {
      get: async ({ sessionID }) => familyInfos.get(sessionID),
    },
    event: {
      subscribe({ signal }) {
        signal.addEventListener('abort', () => wakeEvent(), { once: true })
        return {
          async *[Symbol.asyncIterator]() {
            while (!signal.aborted) {
              if (!eventQueue.length) {
                await new Promise((resolve) => (wakeEvent = resolve))
                if (signal.aborted) break
              }
              while (eventQueue.length) yield eventQueue.shift()
            }
          },
        }
      },
    },
  })
  const closePlugin = pluginCleanup
  cleanups.push(closePlugin)
  for (const [id, info] of familyInfos)
    eventQueue.push({
      id: `event-${id}`,
      type: 'session.status',
      properties: { sessionID: id, status: { type: id === familyRoot ? 'busy' : 'idle' }, info },
    })
  wakeEvent()
  await until(
    async () =>
      (await snapshot(dashboard)).sessions.filter((session) =>
        session.providerSessionId.startsWith('family-'),
      ).length === 8,
    'parent and seven nested subagents reported by the installed plugin',
  )
  for (const owner of [familyRoot, familyChildren[6]]) {
    const formID = `form-${owner}`
    const form = {
      id: formID,
      sessionID: owner,
      title: 'Continue the task?',
      fields: [
        {
          key: 'continue',
          type: 'string',
          title: 'Continue the task?',
          required: true,
          custom: false,
          options: [
            { label: 'Yes', value: 'proceed' },
            { label: 'No', value: 'reconsider' },
          ],
        },
      ],
    }
    familyForms.set(formID, form)
    eventQueue.push({ id: `event-${formID}`, type: 'form.created', data: { form } })
    wakeEvent()
    await until(
      async () =>
        (await snapshot(dashboard)).requests?.some(
          (request) => request.sessionId === `opencode:${owner}`,
        ),
      'installed V2 plugin form reaches Buddy',
    )
    await expand(overlay)
    await openOverlayRow(overlay, 'opencode:family-root')
    await until(
      () =>
        js(
          overlay,
          `document.querySelector('.request-context p')?.textContent === ${JSON.stringify(familyInfos.get(owner).title)}`,
        ),
      'opening a family shows its question owner',
    )
    assert.equal(
      await js(
        overlay,
        `(() => {
      const panel = document.querySelector('.request-panel');
      const agents = document.querySelector('section[aria-label^="Subagents of"] details');
      const question = panel.querySelector('legend').getBoundingClientRect();
      const surface = document.querySelector('.overlay-surface').getBoundingClientRect();
      return !agents.open && Boolean(panel.compareDocumentPosition(agents) & Node.DOCUMENT_POSITION_FOLLOWING)
        && question.top >= surface.top && question.bottom < surface.bottom - 44;
    })()`,
      ),
      true,
      'Parent and nested-child questions stay above collapsed subagents',
    )
    assert.equal(
      await js(overlay, 'document.querySelectorAll(".question-option input:checked").length'),
      0,
    )
    await clickSelector(overlay, '.question-option')
    await until(
      () =>
        js(
          overlay,
          '[...document.querySelectorAll("button")].some(button => button.textContent.trim() === "Send answers" && !button.disabled)',
        ),
      'form selection is ready to submit',
    )
    await click(overlay, 'Send answers')
    await until(
      () => familyAnswers.some((answer) => answer.formID === formID),
      'reply reaches the exact native form',
    )
    assert.deepEqual(
      familyAnswers.find((answer) => answer.formID === formID),
      {
        sessionID: owner,
        formID,
        answer: { continue: 'proceed' },
      },
    )
    await until(
      async () =>
        !(await snapshot(dashboard)).requests?.length &&
        !(await snapshot(dashboard)).sessions.some(
          (session) => session.status === 'needs-attention',
        ),
      'native form acknowledgment clears controls and attention',
    )
  }
  await js(dashboard, `document.querySelector('a[href="/sessions"]').click()`)
  await until(
    () => js(dashboard, 'document.querySelector("h1").textContent === "Sessions"'),
    'session keyboard matrix',
  )
  await clickSelector(dashboard, '.session-row[data-session-id="opencode:family-root"]')
  await waitForSelector(dashboard, '.session-row[data-session-id="opencode:family-child-0"]')
  await js(
    dashboard,
    `(() => { const row = document.querySelector('[data-session-id="opencode:family-root"]'); row.focus(); row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); })()`,
  )
  await until(
    () => js(dashboard, 'document.activeElement.dataset.sessionId === "opencode:family-child-0"'),
    'ArrowDown reaches a subagent',
  )
  assert.equal(
    await js(dashboard, `document.querySelectorAll('.session-row[tabindex="0"]').length`),
    1,
    'One tab stop spans parent and subagents',
  )
  await js(
    dashboard,
    `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
  )
  await until(
    () => js(dashboard, '!document.querySelector(".session-inspector")'),
    'Escape closes session details',
  )
  assert.equal(
    await js(dashboard, 'document.activeElement.dataset.sessionId'),
    'opencode:family-root',
    'Escape restores focus to the parent instead of an unmounted subagent',
  )
  await expand(overlay)
  await openOverlayRow(overlay, 'opencode:family-root')
  await clickSelector(overlay, 'section[aria-label^="Subagents of"] summary')
  await clickSelector(overlay, '[data-session-id="opencode:family-child-0"]')
  await until(
    () => js(overlay, 'document.body.textContent.includes("View parent session")'),
    'child session details rendered',
  )
  await click(overlay, 'View parent session')
  await until(
    () => js(overlay, '!document.body.textContent.includes("View parent session")'),
    'parent details remain reachable after selecting a child',
  )
  pluginCleanup()
  cleanups.splice(cleanups.indexOf(closePlugin), 1)
  await closeService()
  cleanups.splice(cleanups.indexOf(closeService), 1)
  for (const id of familyInfos.keys())
    await report(join(profile, 'bridge.json'), {
      harness: 'opencode',
      event: 'session.deleted',
      sessionId: id,
    })
  await until(async () => !(await snapshot(dashboard)).overlay.visible, 'family fixture closed')
  await js(dashboard, 'window.buddy.removeIntegration("opencode")')
  assert.deepEqual(errors, [])
  console.log(
    'PASS: Telegram settings, authorization and mocked answer round trip; native companion titles; yellow/green/red boundaries; completion; approvals and questions; parent and nested subagent navigation and native V2 form replies; exact replies and attention clearing; dashboard navigation, filters, grouping, pagination, details, setup/removal, placement; dark/light rendering; empty-companion hiding',
  )
  // A final deferred write must survive normal Electron quit.
  await send('SessionStart', 'quit-flush')
  await send('PreToolUse', 'quit-flush')
}

void import('../out/main/index.js')
  .then(verify)
  .then(() => {
    stopping = true
    app.quit()
  })
  .catch(fail)

async function fail(error) {
  if (stopping) return
  stopping = true
  clearTimeout(timeout)
  // A crashed renderer or stalled fixture cleanup must not hang CI forever.
  setTimeout(() => app.exit(1), 5000)
  console.error(error)
  console.error('Renderer errors:', errors)
  for (const [i, window] of windows.entries()) {
    if (window.isDestroyed()) continue
    try {
      writeFileSync(
        join(artifacts, `failure-${i}.png`),
        (await window.webContents.capturePage()).toPNG(),
      )
    } catch {
      /* A crashed renderer may be unable to capture. */
    }
  }
  console.error(`Failure artifacts: ${artifacts}`)
  for (const dispose of cleanups.reverse()) {
    try {
      await dispose()
    } catch (cleanupError) {
      console.error(cleanupError)
    }
  }
  app.once('will-quit', () => app.exit(1))
  app.quit()
}
