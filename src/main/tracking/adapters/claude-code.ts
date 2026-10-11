import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HarnessAdapter } from './types'
import { commonHookEvents, hookRules } from './hooks'

export const claudeCode: HarnessAdapter = {
  id: 'claude-code',
  name: 'Claude Code',
  shortLabel: 'CC',
  description: 'Observation hooks for local Code sessions. Chat and Cowork are separate.',
  source: 'hooks',
  installMode: 'hooks',
  cli: { command: 'claude', extraPaths: [] },
  compat: { verified: '2.1.295' },
  target: () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'),
  hookEvents: () => [
    ...commonHookEvents,
    'Notification',
    'PostToolUseFailure',
    'StopFailure',
    'PermissionDenied',
  ],
  mapEvent(p, ctx) {
    const event = String(p.event)
    if (!this.hookEvents().includes(event)) return null
    const rule = hookRules[event]
    if (!rule) return null
    if (event === 'Notification' && p.notificationType !== 'permission_prompt') return null
    const child = ctx.textField(p.agentId, 128)
    if (event.startsWith('Subagent') && !child) return null
    return {
      ...rule,
      ...(event === 'Notification' ? { status: 'needs-attention', action: 'permission' } : {}),
      ...(child && child !== ctx.sessionId ? { sessionId: child, parentId: ctx.sessionId } : {}),
      ...(event.startsWith('Subagent') ? { turnId: null } : {}),
    }
  },
  displayName: (ordinal) => `Claude ${ordinal + 1}`,
  setupCopy(kind, target) {
    if (kind === 'installed') return 'Restart Claude Code to start tracking sessions.'
    if (kind === 'removed' || kind === 'remove')
      return 'Observer removed. Restart Claude Code to finish disconnecting.'
    if (kind === 'missingCli') return 'Install this CLI, then refresh.'
    if (kind === 'unverified') return 'This version is unverified. Buddy may misreport activity.'
    return `Adds observation hooks to ${target}. Restart Claude Code; disabled or managed-only hooks may prevent reporting.`
  },
}
