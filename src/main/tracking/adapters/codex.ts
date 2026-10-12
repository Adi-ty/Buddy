import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HarnessAdapter } from './types'
import { commonHookEvents, hookRules } from './hooks'

export const codex: HarnessAdapter = {
  id: 'codex',
  name: 'Codex',
  shortLabel: 'CX',
  description: 'Local CLI hooks first. Desktop and IDE runtimes are verified separately.',
  source: 'hooks',
  installMode: 'hooks',
  cli: { command: 'codex', extraPaths: [] },
  compat: {
    verified: '0.162.1',
    async probe(path) {
      const { stdout } = await promisify(execFile)(path, ['features', 'list'], {
        timeout: 2000,
        maxBuffer: 32_768,
      })
      return /^hooks\s+stable\s+true$/m.test(stdout)
    },
  },
  target: () => join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'hooks.json'),
  nameIndex: {
    path: () => join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'session_index.jsonl'),
    idField: 'id',
    nameField: 'thread_name',
  },
  hookEvents: () => [...commonHookEvents, 'Interrupt'],
  mapEvent(p, ctx) {
    const event = String(p.event)
    if (!this.hookEvents().includes(event)) return null
    const rule = hookRules[event]
    if (!rule) return null
    if (event.startsWith('Subagent')) {
      const child = ctx.textField(p.agentId, 128)
      if (!child) return null
      return {
        ...rule,
        turnId: null,
        ...(child !== ctx.sessionId ? { sessionId: child, parentId: ctx.sessionId } : {}),
      }
    }
    return {
      ...rule,
      ...(event === 'PostToolUse' && p.toolFailed === true ? { status: 'error' as const } : {}),
      clearPermissionHints: event === 'PreToolUse',
    }
  },
  displayName: (ordinal) => `Codex ${ordinal + 1}`,
  setupCopy(kind, target) {
    if (kind === 'installed')
      return 'Restart Codex and review Buddy in /hooks. Sessions appear when Codex sends activity.'
    if (kind === 'removed' || kind === 'remove')
      return 'Observer removed. Restart Codex to finish disconnecting.'
    if (kind === 'missingCli') return 'Install this CLI, then refresh.'
    if (kind === 'unverified')
      return 'This version is unverified. Buddy may misreport activity. Hook features and trust are still required.'
    return `Adds observation hooks to ${target}. Restart Codex and review Buddy hooks in /hooks. Buddy never bypasses trust.`
  },
}
