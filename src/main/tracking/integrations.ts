import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { HarnessCatalogEntry, HarnessId } from '../../shared/contracts'
import { ADAPTERS, HARNESSES } from './adapters'
import type { ProfileSettings } from '../settings'
import { parseCliVersion } from '../versions'

const execute = promisify(execFile)
const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export class IntegrationManager {
  private detected = new Map<
    HarnessId,
    { path: string; version: string; compatible: boolean; capable?: boolean }
  >()
  constructor(
    private readonly profile: string,
    private readonly bundled: string,
    private readonly development: boolean,
    private readonly settings?: ProfileSettings,
  ) {}
  target(harness: HarnessId): string {
    return ADAPTERS[harness].target({ profile: this.profile, development: this.development })
  }
  private command(harness: HarnessId): string {
    return `ELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)} ${quote(join(this.profile, 'integrations/reporter.mjs'))} ${quote(harness)} ${quote(join(this.profile, 'bridge.json'))} >/dev/null 2>&1 || :`
  }
  private isOurs(handler: unknown, harness: HarnessId): boolean {
    return (
      object(handler) &&
      handler.type === 'command' &&
      typeof handler.command === 'string' &&
      handler.command.startsWith('ELECTRON_RUN_AS_NODE=1 ') &&
      handler.command.includes(
        ` ${quote(join(this.profile, 'integrations/reporter.mjs'))} ${quote(harness)} ${quote(join(this.profile, 'bridge.json'))}`,
      )
    )
  }
  private controlCommand(harness: HarnessId): string {
    return `ELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)} ${quote(join(this.profile, 'integrations/control-hook.mjs'))} ${quote(harness)} ${quote(join(this.profile, 'controls.json'))}`
  }
  private isControl(handler: unknown, harness: HarnessId): boolean {
    return (
      object(handler) &&
      handler.type === 'command' &&
      typeof handler.command === 'string' &&
      handler.command.startsWith('ELECTRON_RUN_AS_NODE=1 ') &&
      handler.command.includes(
        ` ${quote(join(this.profile, 'integrations/control-hook.mjs'))} ${quote(harness)} ${quote(join(this.profile, 'controls.json'))}`,
      )
    )
  }
  async setControls(harness: HarnessId, enabled: boolean): Promise<void> {
    if (!this.settings) throw new Error('Buddy settings are unavailable')
    if (enabled && this.observerState(harness) !== 'installed')
      throw new Error('Install the observer first.')
    const detected = this.detected.get(harness)
    if (
      enabled &&
      (!detected ||
        detected.capable === false ||
        (!detected.compatible && this.settings.allowedVersion(harness) !== detected.version))
    )
      throw new Error('Refresh integrations and verify this CLI version before enabling replies.')
    const before = this.settings.controlsEnabled(harness)
    this.settings.setControls(harness, enabled)
    try {
      this.syncAssets()
      if (harness !== 'opencode')
        this.updateHooks(harness, this.observerState(harness) !== 'not-installed')
    } catch (error) {
      this.settings.setControls(harness, before)
      throw error
    }
  }
  private configuration(harness: HarnessId): {
    root: Record<string, unknown>
    original: string | null
  } {
    const target = this.target(harness)
    const original = existsSync(target) ? readFileSync(target, 'utf8') : null
    if (original !== null && (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()))
      throw new Error('Configuration must be a regular file')
    const root: unknown = original === null ? {} : JSON.parse(original)
    if (!object(root) || (root.hooks !== undefined && !object(root.hooks)))
      throw new Error('Existing hook configuration is invalid; Buddy left it unchanged')
    return { root, original }
  }
  private observerState(harness: HarnessId): HarnessCatalogEntry['observer'] {
    try {
      if (ADAPTERS[harness].installMode === 'plugin')
        return existsSync(this.target(harness)) &&
          readFileSync(this.target(harness), 'utf8') === this.wrapper(harness)
          ? 'installed'
          : 'not-installed'
      const { root } = this.configuration(harness)
      const hooks = root.hooks as Record<string, unknown> | undefined
      if (!hooks) return 'not-installed'
      const hasObserver = (groups: unknown): boolean =>
        Array.isArray(groups) &&
        groups.some(
          (group) =>
            object(group) &&
            Array.isArray(group.hooks) &&
            group.hooks.some((handler) => this.isOurs(handler, harness)),
        )
      if (this.events(harness).every((event) => hasObserver(hooks[event]))) return 'installed'
      return Object.values(hooks).some(hasObserver) ? 'incomplete' : 'not-installed'
    } catch {
      return 'not-installed'
    }
  }
  private events(harness: HarnessId): string[] {
    return ADAPTERS[harness].hookEvents()
  }
  private controlsConfigured(harness: HarnessId): boolean {
    if (!this.settings?.controlsEnabled(harness)) return false
    if (harness === 'opencode' || harness === 'codex') return true
    try {
      const hooks = this.configuration(harness).root.hooks as Record<string, unknown> | undefined
      return ['PermissionRequest', ...(harness === 'claude-code' ? ['PreToolUse'] : [])].every(
        (event) => {
          const groups = hooks?.[event]
          return (
            Array.isArray(groups) &&
            groups.some(
              (group) =>
                object(group) &&
                (event !== 'PreToolUse' || group.matcher === 'AskUserQuestion') &&
                Array.isArray(group.hooks) &&
                group.hooks.some((handler) => this.isControl(handler, harness)),
            )
          )
        },
      )
    } catch {
      return false
    }
  }
  private wrapper(harness: HarnessId): string {
    return `export { default } from ${JSON.stringify(pathToFileURL(join(this.profile, 'integrations', ADAPTERS[harness].pluginAsset!)).href)}\n`
  }
  async refresh(catalog: readonly HarnessCatalogEntry[]): Promise<HarnessCatalogEntry[]> {
    const entries = await Promise.all(
      catalog.map(async (entry): Promise<HarnessCatalogEntry> => {
        const adapter = ADAPTERS[entry.id]
        const candidates = [
          ...new Set(
            [
              ...(process.env.PATH ?? '').split(':').filter(Boolean),
              join(homedir(), '.local/bin'),
              ...adapter.cli.extraPaths,
              '/opt/homebrew/bin',
              '/usr/local/bin',
            ].map((dir) => join(dir, adapter.cli.command)),
          ),
        ]
        let detected:
          | { path: string; version: string; compatible: boolean; capable: boolean }
          | undefined
        for (const candidate of candidates) {
          try {
            accessSync(candidate, constants.X_OK)
            const { stdout } = await execute(candidate, ['--version'], {
              timeout: 2000,
              maxBuffer: 4096,
            })
            const version = parseCliVersion(stdout)
            if (!version) continue
            // The concrete contracts checked for this implementation. Other
            // versions remain detected but require verification before setup.
            let capable = true
            try {
              capable = !adapter.compat.probe || (await adapter.compat.probe(candidate))
            } catch {
              capable = false
            }
            const compatible = version === adapter.compat.verified && capable
            detected = { path: candidate, version, compatible, capable }
            break
          } catch {
            /* A missing or broken executable is not installed coverage. */
          }
        }
        if (detected) this.detected.set(entry.id, detected)
        else this.detected.delete(entry.id)
        const observer = this.observerState(entry.id)
        return {
          ...entry,
          installation: detected ? 'installed' : 'not-found',
          version: detected?.version,
          canInstall:
            !!detected &&
            detected.capable &&
            (detected.compatible || this.settings?.allowedVersion(entry.id) === detected.version),
          canInstallUnverified: !!detected && detected.capable && !detected.compatible,
          compatibility: !detected?.capable
            ? 'unsupported'
            : detected.compatible
              ? 'verified'
              : 'unverified',
          observer,
          controls: observer === 'installed' && this.controlsConfigured(entry.id),
          connection: observer === 'installed' ? 'configured' : 'not-connected',
          variants:
            'Local CLI is the setup target. Client identity is unknown in hook/plugin events. Desktop and IDE variants require separate live verification; remote/cloud sessions are not covered.',
          setup:
            detected && !detected.capable
              ? 'The required observer feature is unavailable. An unverified-version override cannot enable it.'
              : adapter.setupCopy(
                  observer === 'installed'
                    ? 'installed'
                    : !detected
                      ? 'missingCli'
                      : !detected.compatible
                        ? 'unverified'
                        : 'install',
                  this.target(entry.id),
                ),
          installNotice: adapter.setupCopy('installed', this.target(entry.id)),
          removeNotice: adapter.setupCopy('removed', this.target(entry.id)),
        }
      }),
    )
    // Existing observers keep their configured command/wrapper. Refresh their
    // owned implementation when Buddy updates, without rewriting hook settings.
    if (entries.some((entry) => entry.observer !== 'not-installed')) this.syncAssets()
    return entries
  }
  async install(harness: HarnessId, allowUnverified = false): Promise<void> {
    const detected = this.detected.get(harness)
    if (!detected || detected.capable === false)
      throw new Error('The CLI or required observer feature is unavailable')
    if (!detected.compatible && allowUnverified) {
      if (!this.settings) throw new Error('Buddy settings are unavailable')
      this.settings.allowVersion(harness, detected.version)
    }
    if (!detected.compatible && this.settings?.allowedVersion(harness) !== detected.version)
      throw new Error('Refresh integrations and use a verified CLI version before setup')
    this.syncAssets()
    if (ADAPTERS[harness].installMode === 'plugin') {
      const target = this.target(harness)
      if (existsSync(target) && readFileSync(target, 'utf8') !== this.wrapper(harness))
        throw new Error('A different plugin already uses Buddy’s filename; left unchanged')
      replaceFile(
        target,
        this.wrapper(harness),
        existsSync(target) ? readFileSync(target, 'utf8') : null,
      )
    } else this.updateHooks(harness, true)
  }
  private syncAssets(): void {
    const integrationDirectory = join(this.profile, 'integrations')
    mkdirSync(integrationDirectory, { recursive: true, mode: 0o700 })
    const reporter = readFileSync(join(this.bundled, 'reporter.mjs'), 'utf8')
    const assets: Record<string, string> = { 'reporter.mjs': reporter }
    for (const name of ['control-client.mjs', 'control-hook.mjs'])
      assets[name] = readFileSync(join(this.bundled, name), 'utf8')
    for (const adapter of HARNESSES)
      if (adapter.pluginAsset)
        assets[adapter.pluginAsset] = readFileSync(
          join(this.bundled, adapter.pluginAsset),
          'utf8',
        ).replace("'__BUDDY_BRIDGE_CONFIG__'", JSON.stringify(join(this.profile, 'bridge.json')))
    for (const [name, content] of Object.entries(assets)) {
      const path = join(integrationDirectory, name)
      if (!existsSync(path) || readFileSync(path, 'utf8') !== content)
        replaceFile(path, content, existsSync(path) ? readFileSync(path, 'utf8') : null)
    }
  }
  remove(harness: HarnessId): void {
    if (ADAPTERS[harness].installMode === 'plugin') {
      const target = this.target(harness)
      if (existsSync(target)) {
        if (readFileSync(target, 'utf8') !== this.wrapper(harness))
          throw new Error('Plugin was changed outside Buddy; left unchanged')
        unlinkSync(target)
      }
    } else this.updateHooks(harness, false)
    if (this.settings?.controlsEnabled(harness)) this.settings.setControls(harness, false)
  }
  private updateHooks(harness: HarnessId, install: boolean): void {
    const { root, original } = this.configuration(harness)
    if (!install && original === null) return
    const hooks = (root.hooks ?? {}) as Record<string, unknown>
    if (
      !install &&
      !Object.values(hooks).some(
        (groups) =>
          Array.isArray(groups) &&
          groups.some(
            (group) =>
              object(group) &&
              Array.isArray(group.hooks) &&
              group.hooks.some(
                (handler) => this.isOurs(handler, harness) || this.isControl(handler, harness),
              ),
          ),
      )
    )
      return
    for (const event of this.events(harness)) {
      const existing = hooks[event] ?? []
      if (
        !Array.isArray(existing) ||
        !existing.every((group) => object(group) && Array.isArray(group.hooks))
      )
        throw new Error(`Invalid ${event} hook configuration; left unchanged`)
      const groups = existing
        .map((group) => ({
          ...group,
          hooks: (group.hooks as unknown[]).filter(
            (handler) => !this.isOurs(handler, harness) && !this.isControl(handler, harness),
          ),
        }))
        .filter((group) => group.hooks.length)
      if (install)
        groups.push({ hooks: [{ type: 'command', command: this.command(harness), timeout: 1 }] })
      if (
        install &&
        this.settings?.controlsEnabled(harness) &&
        harness !== 'codex' &&
        (event === 'PermissionRequest' || (harness === 'claude-code' && event === 'PreToolUse'))
      )
        groups.push({
          ...(event === 'PreToolUse' ? { matcher: 'AskUserQuestion' } : {}),
          hooks: [{ type: 'command', command: this.controlCommand(harness), timeout: 125 }],
        })
      if (groups.length) hooks[event] = groups
      else delete hooks[event]
    }
    root.hooks = hooks
    replaceFile(this.target(harness), JSON.stringify(root, null, 2) + '\n', original)
  }
}

function replaceFile(path: string, content: string, original: string | null): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()))
    throw new Error('Refusing to replace a non-regular configuration file')
  if ((existsSync(path) ? readFileSync(path, 'utf8') : null) !== original)
    throw new Error('Configuration changed during setup. Refresh and retry.')
  if (original !== null && original !== content)
    writeFileSync(`${path}.buddy-backup-${randomUUID()}`, original, { flag: 'wx', mode: 0o600 })
  const temporary = `${path}.buddy-${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 })
    if ((existsSync(path) ? readFileSync(path, 'utf8') : null) !== original)
      throw new Error('Configuration changed during setup. Left unchanged.')
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

export function integrationAssets(mainDirectory: string, packaged: boolean): string {
  return packaged
    ? join(process.resourcesPath, 'integrations')
    : resolve(mainDirectory, '../../integrations')
}
