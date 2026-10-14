import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { basename, delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { parseCliVersion } from './versions'

const execute = promisify(execFile)
type Environment = { env: NodeJS.ProcessEnv; error?: string }
export type CliResult = { path?: string; version?: string; error?: string }

// Shell startup output can contain banners or secrets. Read only the framed
// environment, keep it in main-process memory, and never log the raw output.
export async function readShellEnvironment(
  shell: string,
  inherited: NodeJS.ProcessEnv,
  timeout = 10_000,
): Promise<NodeJS.ProcessEnv> {
  if (!isAbsolute(shell) || !['bash', 'zsh', 'sh', 'fish'].includes(basename(shell)))
    throw new Error('Unsupported login shell')
  const marker = randomUUID()
  // Match shell-env's guards against Oh My Zsh updates and tmux auto-start.
  const startupGuards = {
    DISABLE_AUTO_UPDATE: 'true',
    ZSH_TMUX_AUTOSTARTED: 'true',
    ZSH_TMUX_AUTOSTART: 'false',
  }
  const pending = execute(
    shell,
    ['-ilc', `printf '%s' '${marker}'; /usr/bin/env -0; printf '%s' '${marker}'`],
    {
      env: { ...inherited, ...startupGuards },
      cwd: inherited.HOME || homedir(),
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: 256 * 1024,
    },
  )
  // Startup scripts must receive EOF instead of waiting for interactive input.
  pending.child.stdin?.end()
  const { stdout } = await pending
  const framed = stdout.split(marker)
  if (framed.length !== 3) throw new Error('Missing shell environment')
  const env: NodeJS.ProcessEnv = {}
  for (const entry of framed[1]!.split('\0')) {
    const separator = entry.indexOf('=')
    if (separator > 0) env[entry.slice(0, separator)] = entry.slice(separator + 1)
  }
  if (!env.PATH) throw new Error('Missing shell PATH')
  for (const key of Object.keys(startupGuards)) delete env[key]
  // Explicit launch settings (including scratch harness profiles) win. Only
  // PATH must come from the login shell when launching from Finder/the Dock.
  return { ...env, ...inherited, PATH: env.PATH }
}

export class CliDiscovery {
  private cached?: Promise<Environment>
  constructor(
    private readonly options: {
      resolveShell: boolean
      env?: NodeJS.ProcessEnv
      shell?: string
    },
  ) {}
  environment(refresh = false): Promise<Environment> {
    if (refresh) this.cached = undefined
    return (this.cached ??= this.resolveEnvironment())
  }
  private async resolveEnvironment(): Promise<Environment> {
    const env = { ...(this.options.env ?? process.env) }
    if (!this.options.resolveShell || process.platform === 'win32') return { env }
    try {
      const shell = this.options.shell || env.SHELL || userInfo().shell || '/bin/zsh'
      return { env: await readShellEnvironment(shell, env) }
    } catch {
      return {
        env,
        error:
          'Could not read your login-shell environment. Check your shell startup, then Refresh, or choose an executable.',
      }
    }
  }
}

export async function validateExecutable(path: string): Promise<void> {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('Choose an executable file.')
  try {
    await access(path, constants.X_OK)
    if (!(await stat(path)).isFile()) throw new Error('Not a file')
  } catch {
    throw new Error('Choose an executable file that Buddy can run.')
  }
}

export function cliEnvironment(
  env: NodeJS.ProcessEnv,
  extraPaths: readonly string[],
): NodeJS.ProcessEnv {
  const paths = [
    ...(env.PATH ?? '').split(delimiter),
    join(env.HOME || homedir(), '.local/bin'),
    ...extraPaths,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ].filter((path) => isAbsolute(path))
  // Ignore relative/empty PATH entries: a GUI app's working directory is not
  // a trusted location for discovering or running a coding agent.
  return { ...env, PATH: [...new Set(paths)].join(delimiter) }
}

export async function findCli(
  command: string,
  env: NodeJS.ProcessEnv,
  override?: string | null,
): Promise<CliResult> {
  const candidates = override
    ? [override]
    : (env.PATH ?? '')
        .split(delimiter)
        .filter(isAbsolute)
        .map((dir) => join(dir, command))
  for (const path of candidates) {
    try {
      await validateExecutable(path)
    } catch {
      if (override) return { path, error: 'The chosen executable is missing or cannot be run.' }
      continue
    }
    try {
      const { stdout } = await execute(path, ['--version'], {
        env,
        cwd: env.HOME || homedir(),
        timeout: 2000,
        killSignal: 'SIGKILL',
        maxBuffer: 4096,
      })
      const version = parseCliVersion(stdout)
      if (version) return { path, version }
      return {
        path,
        error:
          'The CLI did not report a recognizable version. Check this executable or choose another.',
      }
    } catch {
      // A broken first match must not silently select a different installation.
      return {
        path,
        error:
          'The CLI was found but could not run --version. Check its runtime and shell setup, or choose another executable.',
      }
    }
  }
  return {}
}
