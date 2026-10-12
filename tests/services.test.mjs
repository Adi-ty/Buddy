import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadSource } from './load-source.mjs'

const { SessionNotifications, ProfileSettings, IntegrationManager, performSessionAction } =
  await loadSource('tests/services-entry.ts', { electron: 'tests/electron-mock.mjs' })
const record = (id, status) => ({
  id,
  name: `Agent ${id}`,
  project: 'buddy',
  presence: 'observed',
  status,
  attention: [{ id: 'permission', kind: 'permission', tool: 'Bash' }],
})
const notificationFixture = () => {
  const shown = []
  let enabled = true
  let opened = 0
  const service = new SessionNotifications(
    () => enabled,
    () => opened++,
    (options) => {
      const notice = new EventEmitter()
      notice.show = () => shown.push({ ...options, notice })
      notice.close = () => notice.emit('close')
      return notice
    },
  )
  return {
    service,
    shown,
    opened: () => opened,
    disable: () => {
      enabled = false
    },
  }
}

test('notifications deduplicate attention, rearm on exit, aggregate bursts and only focus on click', (t) => {
  const fixture = notificationFixture()
  t.after(() => fixture.service.reset())
  const waiting = record('one', 'needs-attention')
  fixture.service.observe(null, waiting)
  fixture.service.flush()
  assert.equal(fixture.shown.length, 1)
  assert.equal(fixture.shown[0].body, 'Permission for Bash · buddy')
  assert.equal(fixture.opened(), 0)
  fixture.service.observe(waiting, { ...waiting })
  fixture.service.flush()
  assert.equal(fixture.shown.length, 1)
  fixture.shown[0].notice.emit('click')
  assert.equal(fixture.opened(), 1)
  const working = record('one', 'working')
  fixture.service.observe(waiting, working)
  fixture.service.observe(working, waiting)
  fixture.service.observe(null, record('two', 'needs-attention'))
  fixture.service.flush()
  assert.equal(fixture.shown.length, 2)
  assert.equal(fixture.shown[1].title, 'Buddy')
  assert.equal(fixture.shown[1].body, '2 sessions need your attention')
})

test('errors are cooled down, disabled notifications stay quiet, and native failures are harmless', (t) => {
  const fixture = notificationFixture()
  t.after(() => fixture.service.reset())
  const error = record('one', 'error')
  const idle = record('one', 'idle')
  fixture.service.observe(null, error, 1000)
  fixture.service.flush()
  fixture.service.observe(error, idle, 2000)
  fixture.service.observe(idle, error, 3000)
  fixture.service.flush()
  assert.equal(fixture.shown.length, 1)
  fixture.service.observe(error, idle, 61_000)
  fixture.service.observe(idle, error, 62_000)
  fixture.service.flush()
  assert.equal(fixture.shown.length, 2)
  fixture.disable()
  fixture.service.observe(null, record('two', 'needs-attention'))
  fixture.service.flush()
  assert.equal(fixture.shown.length, 2)
  const unavailable = new SessionNotifications(
    () => true,
    () => {},
    () => {
      throw new Error('Native failure')
    },
  )
  unavailable.observe(null, error)
  assert.doesNotThrow(() => unavailable.flush())
})

test('an aggregate notice stays mapped until all associated sessions resolve or disappear', (t) => {
  for (const eviction of [false, true]) {
    const fixture = notificationFixture()
    t.after(() => fixture.service.reset())
    const one = record('one', 'needs-attention')
    const two = record('two', 'needs-attention')
    fixture.service.observe(null, one)
    fixture.service.observe(null, two)
    fixture.service.flush()
    let closed = 0
    fixture.shown[0].notice.on('close', () => closed++)
    if (eviction) fixture.service.reconcileObserved([two])
    else fixture.service.observe(one, record('one', 'working'))
    assert.equal(closed, 0, 'Resolving one member must preserve the remaining alert')
    fixture.service.observe(two, record('two', 'working'))
    assert.equal(closed, 1)
  }
})

test('settings persist exact version consent and preserve unrelated or damaged data', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'buddy-settings-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'settings.json')
  writeFileSync(path, JSON.stringify({ unrelated: 'keep' }))
  const settings = new ProfileSettings(path)
  assert.equal(settings.desktopNotifications, true)
  settings.setDesktopNotifications(false)
  settings.allowVersion('codex', '9.9.9')
  const restored = new ProfileSettings(path)
  assert.equal(restored.desktopNotifications, false)
  assert.equal(restored.allowedVersion('codex'), '9.9.9')
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).unrelated, 'keep')
  writeFileSync(path, '{broken')
  const damaged = new ProfileSettings(path)
  assert.throws(() => damaged.setDesktopNotifications(false))
  assert.equal(readFileSync(path, 'utf8'), '{broken')
})

test(
  'unverified installs require explicit exact-version consent and cannot bypass feature probes',
  { timeout: 10_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'buddy-version-test-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const settings = new ProfileSettings(join(directory, 'settings.json'))
    const manager = new IntegrationManager(
      directory,
      join(process.cwd(), 'integrations'),
      true,
      settings,
    )
    manager.target = () => join(directory, 'hooks.json')
    manager.detected.set('codex', { version: '9.9.9', compatible: false, capable: true })
    await assert.rejects(manager.install('codex'))
    await manager.install('codex', true)
    assert.equal(settings.allowedVersion('codex'), '9.9.9')
    await manager.install('codex')
    manager.detected.set('codex', { version: '9.9.10', compatible: false, capable: true })
    await assert.rejects(manager.install('codex'))
    manager.detected.set('codex', { version: '9.9.9', compatible: false, capable: false })
    await assert.rejects(manager.install('codex', true))
    assert.equal(settings.allowedVersion('codex'), '9.9.9')
  },
)

test(
  'reply setup preserves other hooks, captures decision output, scopes questions to Claude and removes owned controls',
  { timeout: 10_000 },
  async (t) => {
    for (const harness of ['codex', 'claude-code']) {
      const profile = mkdtempSync(join(tmpdir(), 'buddy-controls-setup-'))
      t.after(() => rmSync(profile, { recursive: true, force: true }))
      const target = join(profile, 'hooks.json')
      const keep = { hooks: [{ type: 'command', command: 'keep-my-hook' }] }
      writeFileSync(
        target,
        JSON.stringify({ unrelated: true, hooks: { PermissionRequest: [keep] } }),
      )
      const settings = new ProfileSettings(join(profile, 'settings.json'))
      const manager = new IntegrationManager(
        profile,
        join(process.cwd(), 'integrations'),
        true,
        settings,
      )
      manager.target = () => target
      manager.detected.set(harness, { compatible: true, capable: true, version: 'fixture' })
      await manager.install(harness)
      await manager.setControls(harness, true)
      const hooks = JSON.parse(readFileSync(target, 'utf8')).hooks
      assert.deepEqual(hooks.PermissionRequest[0], keep)
      const control = hooks.PermissionRequest.flatMap((p) => p.hooks).find((p) =>
        p.command.includes('control-hook.mjs'),
      )
      if (harness === 'codex')
        assert.equal(control, undefined, 'Native Codex approval must remain visible in Codex')
      else {
        assert(control)
        assert(!control.command.includes('>/dev/null'), 'Policy JSON must reach the actual harness')
        assert(control.timeout > 120)
      }
      assert(!JSON.stringify(hooks.PreToolUse).includes('control-hook.mjs'))
      assert.equal(
        new ProfileSettings(join(profile, 'settings.json')).controlsEnabled(harness),
        true,
      )
      await manager.setControls(harness, false)
      assert(!readFileSync(target, 'utf8').includes('control-hook.mjs'))
      manager.remove(harness)
      assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), {
        unrelated: true,
        hooks: { PermissionRequest: [keep] },
      })
    }
  },
)

test('refresh moves an outdated Claude question hook onto the racing PermissionRequest hook', async (t) => {
  const profile = mkdtempSync(join(tmpdir(), 'buddy-controls-migration-'))
  t.after(() => rmSync(profile, { recursive: true, force: true }))
  const target = join(profile, 'hooks.json')
  const keep = { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: 'keep-my-hook' }] }
  writeFileSync(target, JSON.stringify({ hooks: { PreToolUse: [keep] } }))
  const settings = new ProfileSettings(join(profile, 'settings.json'))
  const manager = new IntegrationManager(
    profile,
    join(process.cwd(), 'integrations'),
    true,
    settings,
  )
  manager.target = () => target
  manager.detected.set('claude-code', { compatible: true, capable: true, version: 'fixture' })
  await manager.install('claude-code')
  await manager.setControls('claude-code', true)
  const config = JSON.parse(readFileSync(target, 'utf8'))
  const control = config.hooks.PermissionRequest.at(-1).hooks[0]
  control.timeout = 125
  config.hooks.PreToolUse.push({ matcher: 'AskUserQuestion', hooks: [{ ...control }] })
  writeFileSync(target, JSON.stringify(config))
  const [entry] = await manager.refresh([{ id: 'claude-code', name: 'Claude Code' }])
  assert.equal(entry.controls, true)
  const hooks = JSON.parse(readFileSync(target, 'utf8')).hooks
  assert.deepEqual(hooks.PreToolUse[0], keep)
  assert(!JSON.stringify(hooks.PreToolUse).includes('control-hook.mjs'))
  assert.equal(hooks.PermissionRequest.at(-1).hooks[0].timeout, 610)
  const migrated = readFileSync(target, 'utf8')
  await manager.refresh([{ id: 'claude-code', name: 'Claude Code' }])
  assert.equal(readFileSync(target, 'utf8'), migrated)
})

test(
  'all harnesses install and remove within relocated user configuration directories',
  { timeout: 10_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'buddy portable setup '))
    const overrides = {
      CODEX_HOME: join(directory, 'custom codex'),
      CLAUDE_CONFIG_DIR: join(directory, 'custom claude'),
      OPENCODE_CONFIG_DIR: join(directory, 'custom opencode'),
      XDG_CONFIG_HOME: join(directory, 'xdg config'),
    }
    const previous = Object.fromEntries(
      Object.keys(overrides).map((key) => [key, process.env[key]]),
    )
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(directory, { recursive: true, force: true })
    })
    Object.assign(process.env, overrides)
    const profile = join(directory, 'Buddy app data')
    mkdirSync(profile)
    const settings = new ProfileSettings(join(profile, 'settings.json'))
    const manager = new IntegrationManager(
      profile,
      join(process.cwd(), 'integrations'),
      false,
      settings,
    )
    const targets = {
      codex: join(overrides.CODEX_HOME, 'hooks.json'),
      'claude-code': join(overrides.CLAUDE_CONFIG_DIR, 'settings.json'),
      opencode: join(overrides.OPENCODE_CONFIG_DIR, 'plugins/buddy.js'),
    }
    const original = {
      unrelated: 'keep',
      hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'other-hook' }] }] },
    }
    for (const [harness, target] of Object.entries(targets)) {
      assert.equal(manager.target(harness), target)
      if (harness !== 'opencode') {
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, JSON.stringify(original))
      }
      manager.detected.set(harness, { compatible: true, capable: true, version: 'fixture' })
      await manager.install(harness)
      await manager.setControls(harness, true)
      const installed = readFileSync(target, 'utf8')
      if (harness === 'opencode') {
        assert(
          installed.includes(pathToFileURL(join(profile, 'integrations/opencode-plugin.mjs')).href),
        )
        assert(!existsSync(join(overrides.XDG_CONFIG_HOME, 'opencode/plugins/buddy.js')))
      } else {
        assert(installed.includes(profile), 'Hook paths are generated from this app profile')
        assert.equal(JSON.parse(installed).unrelated, 'keep')
      }
      manager.remove(harness)
      if (harness === 'opencode') assert(!existsSync(target))
      else assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), original)
    }
    delete process.env.OPENCODE_CONFIG_DIR
    const fallback = join(overrides.XDG_CONFIG_HOME, 'opencode/plugins/buddy.js')
    assert.equal(manager.target('opencode'), fallback)
    await manager.install('opencode')
    assert(existsSync(fallback))
    manager.remove('opencode')
    assert(!existsSync(fallback))
  },
)

test('native session actions resolve canonical paths and reject forged, missing and invalid requests', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'buddy-session-actions-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const paths = []
  const copied = []
  const native = {
    writeText: (text) => copied.push(text),
    showItemInFolder: (path) => paths.push(path),
  }
  const store = {
    get: (id) => (id === 'known' ? { cwd: directory, providerSessionId: 'provider-id' } : null),
  }
  performSessionAction(store, 'known', 'copyId', native)
  performSessionAction(store, 'known', 'copyPath', native)
  performSessionAction(store, 'known', 'reveal', native)
  assert.deepEqual(copied, ['provider-id', directory])
  assert.deepEqual(paths, [directory])
  assert.throws(() => performSessionAction(store, directory, 'reveal', native))
  assert.throws(() => performSessionAction(store, 'known', { path: '/forged' }, native))
  assert.throws(() => performSessionAction(null, 'known', 'copyId', native))
  assert.throws(() =>
    performSessionAction({ get: () => ({ cwd: 'relative' }) }, 'known', 'copyPath', native),
  )
})

test('eviction or persistence failure suppresses notifications for no-longer-observed sessions', (t) => {
  const fixture = notificationFixture()
  t.after(() => fixture.service.reset())
  fixture.service.observe(null, record('pending', 'needs-attention'))
  fixture.service.reconcileObserved([])
  fixture.service.flush()
  assert.equal(fixture.shown.length, 0)
})

test(
  'malformed hook configuration is surfaced as incomplete and never rewritten',
  { timeout: 10_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'buddy-invalid-config-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const target = join(directory, 'settings.json')
    const original = '{ // JSONC is not accepted by this hook target\n "hooks": {} }'
    writeFileSync(target, original)
    const manager = new IntegrationManager(directory, join(process.cwd(), 'integrations'), true)
    manager.target = () => target
    const [entry] = await manager.refresh([
      { id: 'claude-code', name: 'Claude Code', observer: 'not-installed' },
    ])
    assert.equal(entry.observer, 'incomplete')
    assert.match(entry.configurationError, /not valid JSON/)
    assert.equal(entry.canInstall, false)
    assert.equal(readFileSync(target, 'utf8'), original)
    assert.throws(() => manager.remove('claude-code'), /not valid JSON/)
  },
)

test('missing project reveal reports an actionable error without native filesystem details', () => {
  assert.throws(
    () =>
      performSessionAction(
        { get: () => ({ cwd: '/does-not-exist-buddy-test' }) },
        'known',
        'reveal',
        { showItemInFolder() {} },
      ),
    { message: 'Project folder is unavailable. It may have moved or been deleted.' },
  )
})
