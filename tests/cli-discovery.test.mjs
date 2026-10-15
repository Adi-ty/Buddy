import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadSource } from './load-source.mjs'

const { CliDiscovery, readShellEnvironment, cliEnvironment, findCli, validateExecutable } =
  await loadSource('src/main/cli-discovery.ts')
const { IntegrationManager } = await loadSource('src/main/tracking/integrations.ts')
const { ProfileSettings } = await loadSource('src/main/settings.ts')
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const versions = { codex: '0.162.1', claude: '2.1.295', opencode: '2.0.29' }

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'buddy-discovery-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, "custom bin's directory")
  mkdirSync(bin)
  const env = { HOME: root, PATH: bin }
  const executable = (path, body) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 })
    return path
  }
  // A controlled shell models GUI login startup without reading user configs.
  const shell = executable(
    join(root, 'zsh'),
    `echo 'startup banner'; export PATH=${quote(bin)}; exec /bin/sh -c "$2"`,
  )
  return { root, bin, env, shell, executable }
}

test('GUI shell discovery finds all harnesses and preserves launch profiles through capability probes', async (t) => {
  const f = fixture(t)
  const tools = join(f.root, 'runtime')
  mkdirSync(tools)
  symlinkSync(process.execPath, join(tools, 'node'))
  for (const [command, version] of Object.entries(versions)) {
    writeFileSync(
      join(f.bin, command),
      `#!/usr/bin/env node\nif (process.env.CODEX_HOME !== ${JSON.stringify(join(f.root, 'scratch-codex'))}) process.exit(1);\nconsole.log(process.argv[2] === '--version' ? '${version}' : 'hooks stable true');\n`,
      { mode: 0o700 },
    )
  }
  f.executable(
    f.shell,
    `echo 'startup banner'; export PATH=${quote(`${f.bin}:${tools}`)}; export CODEX_HOME=/wrong-profile; exec /bin/sh -c "$2"`,
  )
  const inherited = {
    HOME: f.root,
    PATH: '/usr/bin:/bin',
    CODEX_HOME: join(f.root, 'scratch-codex'),
  }
  const discovery = new CliDiscovery({ resolveShell: true, env: inherited, shell: f.shell })
  const settings = new ProfileSettings(join(f.root, 'settings.json'))
  const manager = new IntegrationManager(
    f.root,
    join(process.cwd(), 'integrations'),
    true,
    settings,
    discovery,
  )
  manager.target = (id) => join(f.root, id, 'hooks.json')
  const entries = await manager.refresh(['codex', 'claude-code', 'opencode'].map((id) => ({ id })))
  for (const entry of entries) {
    const command = entry.id === 'claude-code' ? 'claude' : entry.id
    assert.equal(entry.installation, 'installed', command)
    assert.equal(entry.version, versions[command])
    assert.equal(entry.executablePath, join(f.bin, command))
    assert.equal(entry.canInstall, true, `${command} capability uses the same runtime PATH`)
    assert.equal(entry.discoveryError, undefined)
    assert.equal(entry.observer, 'not-installed')
  }
  assert.deepEqual(inherited, {
    HOME: f.root,
    PATH: '/usr/bin:/bin',
    CODEX_HOME: join(f.root, 'scratch-codex'),
  })
})

test('shell environment keeps multiline values and ignores startup banners', async (t) => {
  const f = fixture(t)
  const env = await readShellEnvironment(f.shell, { ...f.env, EXAMPLE: 'line1\nline2=value' })
  assert.equal(env.PATH, f.bin)
  assert.equal(env.EXAMPLE, 'line1\nline2=value')
  assert.equal(env.HOME, f.root)
  assert.equal(env.DISABLE_AUTO_UPDATE, undefined, 'shell startup guards do not leak into probes')
})

test('shell startup receives EOF when it tries to read input', async (t) => {
  const f = fixture(t)
  f.executable(
    f.shell,
    `printf 'continue? '; read answer; export PATH=${quote(f.bin)}; exec /bin/sh -c "$2"`,
  )
  const env = await readShellEnvironment(f.shell, f.env, 1500)
  assert.equal(env.PATH, f.bin)
})

test(
  'real zsh login and interactive startup supplies a custom CLI path',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const f = fixture(t)
    writeFileSync(
      join(f.root, '.zshrc'),
      `read answer\nexport PATH=${quote(f.bin)}\nprint 'shell greeting'\n`,
    )
    const path = f.executable(join(f.bin, 'opencode'), 'echo v2.0.0')
    const env = await readShellEnvironment('/bin/zsh', {
      HOME: f.root,
      ZDOTDIR: f.root,
      PATH: '/usr/bin:/bin',
    })
    assert.equal(env.PATH, f.bin)
    assert.deepEqual(await findCli('opencode', env), { path, version: '2.0.0' })
  },
)

test('CLI/dev launches retain their selected PATH and never invoke a login shell', async (t) => {
  const f = fixture(t)
  const discovery = new CliDiscovery({ resolveShell: false, env: f.env, shell: '/missing/shell' })
  assert.deepEqual(await discovery.environment(), { env: f.env })
})

test('shell lookup is shared across refreshes, while explicit refresh reloads changed setup', async (t) => {
  const f = fixture(t)
  const discovery = new CliDiscovery({ resolveShell: true, env: f.env, shell: f.shell })
  const first = discovery.environment()
  assert.equal(first, discovery.environment())
  assert.equal((await first).env.PATH, f.bin)
  f.executable(f.shell, `export PATH=/new/location; exec /bin/sh -c "$2"`)
  assert.equal((await discovery.environment()).env.PATH, f.bin)
  assert.equal((await discovery.environment(true)).env.PATH, '/new/location')
})

for (const [name, body] of [
  ['nonzero exit', 'echo private-startup-detail >&2; exit 1'],
  ['missing frame', 'echo private-startup-detail'],
  ['oversized output', '/usr/bin/yes private-startup-detail | /usr/bin/head -c 300000'],
]) {
  test(`shell ${name} falls back with a safe diagnostic and retries on refresh`, async (t) => {
    const f = fixture(t)
    f.executable(f.shell, body)
    const discovery = new CliDiscovery({ resolveShell: true, env: f.env, shell: f.shell })
    const result = await discovery.environment()
    assert.deepEqual(result.env, f.env)
    assert.match(result.error, /login-shell/)
    assert.ok(!result.error.includes('private-startup-detail'))
    f.executable(f.shell, 'exec /bin/sh -c "$2"')
    assert.equal((await discovery.environment(true)).error, undefined)
  })
}

test('hanging shell startup is bounded; missing and unsupported shells fall back', async (t) => {
  const f = fixture(t)
  f.executable(f.shell, 'exec /bin/sleep 30')
  const start = Date.now()
  await assert.rejects(readShellEnvironment(f.shell, f.env, 100))
  assert.ok(Date.now() - start < 2000)
  for (const shell of ['/missing/zsh', '/bin/unsupported']) {
    const result = await new CliDiscovery({ resolveShell: true, env: f.env, shell }).environment()
    assert.deepEqual(result.env, f.env)
    assert.match(result.error, /login-shell/)
  }
})

test('PATH order wins over known locations; symlinks, spaces and runtime shims work', async (t) => {
  const f = fixture(t)
  const alternate = join(f.root, 'alternate')
  const runtime = join(f.root, 'runtime')
  mkdirSync(runtime)
  symlinkSync(process.execPath, join(runtime, 'node'))
  const real = join(f.root, 'versioned-package')
  writeFileSync(real, '#!/usr/bin/env node\nconsole.log("v2.1.0")\n', { mode: 0o700 })
  symlinkSync(real, join(f.bin, 'opencode'))
  f.executable(join(alternate, 'opencode'), 'echo 2.0.0')
  const env = cliEnvironment({ ...f.env, PATH: `${f.bin}:${runtime}:${f.bin}` }, [alternate])
  assert.equal(env.PATH.split(':').filter((path) => path === f.bin).length, 1)
  assert.deepEqual(await findCli('opencode', env), {
    path: join(f.bin, 'opencode'),
    version: '2.1.0',
  })
})

test('known install directories work without a shell PATH and relative entries are ignored', async (t) => {
  const f = fixture(t)
  const local = f.executable(join(f.root, '.local/bin/claude'), 'echo "Claude Code 2.1.295"')
  const custom = f.executable(join(f.root, '.opencode/bin/opencode'), 'echo v2.0.0')
  const env = cliEnvironment({ HOME: f.root, PATH: ':.:relative' }, [dirname(custom)])
  assert.ok(!env.PATH.split(':').some((path) => !path.startsWith('/')))
  assert.equal((await findCli('claude', env)).path, local)
  assert.equal((await findCli('opencode', env)).path, custom)
})

for (const [name, body] of [
  ['failed execution', 'echo private-runtime-detail >&2; exit 1'],
  ['missing runtime', 'exec missing-buddy-test-runtime'],
  ['unrecognized version', 'echo unknown'],
  ['timeout', 'exec /bin/sleep 30'],
  ['excessive output', '/usr/bin/yes private-runtime-detail | /usr/bin/head -c 10000'],
]) {
  test(`a preferred CLI with ${name} is reported as broken instead of using another install`, async (t) => {
    const f = fixture(t)
    const path = f.executable(join(f.bin, 'codex'), body)
    const other = f.executable(join(f.root, 'other/codex'), 'echo 0.162.1')
    const result = await findCli('codex', { ...f.env, PATH: `${f.bin}:${dirname(other)}` })
    assert.equal(result.path, path)
    assert.equal(result.version, undefined)
    assert.ok(result.error)
    assert.ok(!result.error.includes('private-runtime-detail'))
  })
}

test('directories, dangling symlinks and non-executable files are not CLI commands', async (t) => {
  const f = fixture(t)
  mkdirSync(join(f.bin, 'codex'))
  symlinkSync('/missing/target', join(f.bin, 'claude'))
  writeFileSync(join(f.bin, 'opencode'), 'not executable', { mode: 0o600 })
  for (const command of Object.keys(versions)) assert.deepEqual(await findCli(command, f.env), {})
  for (const path of [
    'relative/path',
    join(f.bin, 'codex'),
    join(f.bin, 'claude'),
    join(f.bin, 'opencode'),
  ])
    await assert.rejects(validateExecutable(path))
})

test('manual overrides persist, take priority, expose broken paths, and reset to automatic detection', async (t) => {
  const f = fixture(t)
  const auto = f.executable(join(f.bin, 'opencode'), 'echo 2.0.0')
  const chosen = f.executable(join(f.root, 'custom tool; $(touch never)'), 'echo v2.1.0')
  const settingsFile = join(f.root, 'settings.json')
  const settings = new ProfileSettings(settingsFile)
  const discovery = new CliDiscovery({ resolveShell: false, env: f.env })
  const manager = new IntegrationManager(
    f.root,
    join(process.cwd(), 'integrations'),
    true,
    settings,
    discovery,
  )
  manager.target = () => join(f.root, 'config/hooks.json')
  const catalog = [{ id: 'opencode' }]
  await manager.chooseExecutable('opencode', chosen)
  assert.equal(new ProfileSettings(settingsFile).executable('opencode'), chosen)
  let [entry] = await manager.refresh(catalog)
  assert.equal(entry.executablePath, chosen)
  assert.equal(entry.version, '2.1.0')
  assert.equal(entry.executableOverride, true)
  chmodSync(chosen, 0o600)
  ;[entry] = await manager.refresh(catalog)
  assert.equal(entry.installation, 'broken')
  assert.equal(entry.canInstall, false)
  assert.equal(entry.executablePath, chosen)
  await assert.rejects(manager.chooseExecutable('opencode', f.root))
  assert.equal(
    settings.executable('opencode'),
    chosen,
    'invalid selection preserves previous choice',
  )
  await manager.chooseExecutable('opencode', null)
  ;[entry] = await manager.refresh(catalog)
  assert.equal(entry.executablePath, auto)
  assert.equal(entry.executableOverride, false)
  assert.equal(new ProfileSettings(settingsFile).executable('opencode'), null)
})

test('discovery distinguishes unsupported versions from missing/broken installations', async (t) => {
  const f = fixture(t)
  f.executable(join(f.bin, 'opencode'), 'echo 1.18.35')
  const manager = new IntegrationManager(
    f.root,
    join(process.cwd(), 'integrations'),
    true,
    undefined,
    new CliDiscovery({ resolveShell: false, env: f.env }),
  )
  manager.target = () => join(f.root, 'hooks.json')
  const [entry] = await manager.refresh([{ id: 'opencode' }])
  assert.equal(entry.installation, 'installed')
  assert.equal(entry.compatibility, 'unsupported')
  assert.equal(entry.canInstall, false)
  assert.equal(entry.discoveryError, undefined)
})

test('path settings preserve unrelated preferences and reject shell commands', async (t) => {
  const f = fixture(t)
  const path = join(f.root, 'settings.json')
  writeFileSync(
    path,
    JSON.stringify({ desktopNotifications: false, controls: ['codex'], future: 7 }),
  )
  const settings = new ProfileSettings(path)
  settings.setExecutable('codex', '/custom/codex')
  settings.setExecutable('claude-code', '/custom/claude')
  settings.setExecutable('codex', null)
  assert.equal(settings.executable('claude-code'), '/custom/claude')
  assert.equal(settings.desktopNotifications, false)
  assert.equal(settings.controlsEnabled('codex'), true)
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).future, 7)
  assert.throws(() => settings.setExecutable('codex', 'npx codex'))
})

test('OpenCode V2 migration is explicit, version-scoped and preserves a V1 observer on refresh', async (t) => {
  const f = fixture(t)
  const executable = join(f.bin, 'opencode')
  f.executable(executable, 'echo 2.0.29')
  const settings = new ProfileSettings(join(f.root, 'settings.json'))
  const manager = new IntegrationManager(
    f.root,
    join(process.cwd(), 'integrations'),
    true,
    settings,
    new CliDiscovery({ resolveShell: false, env: f.env }),
  )
  manager.target = () => join(f.root, 'plugin.js')
  const catalog = [{ id: 'opencode' }]
  let [entry] = await manager.refresh(catalog)
  assert.equal(entry.compatibility, 'verified')
  await manager.install('opencode')
  for (const name of ['opencode-plugin.mjs', 'opencode-api.mjs', 'opencode-forms.mjs'])
    assert(readFileSync(join(f.root, 'integrations', name), 'utf8').length > 0)
  const asset = join(f.root, 'integrations/opencode-plugin.mjs')
  const wrapper = readFileSync(manager.target(), 'utf8')
  writeFileSync(asset, '// prior V1 observer')
  f.executable(executable, 'echo 1.18.35')
  ;[entry] = await manager.refresh(catalog)
  assert.equal(entry.compatibility, 'unsupported')
  assert.equal(entry.canInstall, false)
  assert.equal(entry.canInstallUnverified, false)
  assert.match(entry.setup, /V1 is no longer supported/)
  await assert.rejects(() => manager.install('opencode', true), /unavailable/)
  assert.equal(readFileSync(asset, 'utf8'), '// prior V1 observer')
  assert.equal(readFileSync(manager.target(), 'utf8'), wrapper)
  f.executable(executable, 'echo 2.1.0-beta.1')
  ;[entry] = await manager.refresh(catalog)
  assert.equal(entry.compatibility, 'unverified')
  assert.equal(entry.canInstall, false)
  assert.equal(entry.canInstallUnverified, true)
  await assert.rejects(() => manager.install('opencode'), /version/)
  await manager.install('opencode', true)
  assert.equal(settings.allowedVersion('opencode'), '2.1.0-beta.1')
  assert.notEqual(readFileSync(asset, 'utf8'), '// prior V1 observer')
})
