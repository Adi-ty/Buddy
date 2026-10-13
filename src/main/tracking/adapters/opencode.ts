import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HarnessAdapter, EventMapping } from './types'

export const opencode: HarnessAdapter = {
  id: 'opencode',
  name: 'OpenCode',
  shortLabel: 'OC',
  description: 'OpenCode V2 plugin event tracking.',
  source: 'plugin',
  installMode: 'plugin',
  pluginAsset: 'opencode-plugin.mjs',
  cli: { command: 'opencode', extraPaths: [join(homedir(), '.opencode/bin')] },
  compat: {
    verified: '2.x',
    matches: (version) => /^2\./.test(version),
    supports: (version) => /^2\./.test(version),
  },
  target: ({ development }) =>
    join(
      process.env.OPENCODE_CONFIG_DIR ||
        join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode'),
      'plugins',
      development ? 'buddy-dev.js' : 'buddy.js',
    ),
  hookEvents: () => [],
  nameStorage: {
    kind: 'opencode-db',
    path: () =>
      join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'opencode/opencode.db'),
  },
  mapEvent(p, ctx) {
    let result: EventMapping
    switch (p.event) {
      case 'session.created':
      case 'session.updated':
        result = { status: null, action: 'metadata' }
        break
      case 'session.deleted':
        result = { status: null, action: 'close' }
        break
      case 'session.status':
      case 'buddy.reconcile': {
        if (!['busy', 'idle', 'retry', 'running'].includes(String(p.status))) return null
        result = {
          status: p.status === 'idle' ? 'idle' : 'working',
          action: 'observe',
          idleCompletesTurn: p.status === 'idle',
          turnActive: p.status !== 'idle',
        }
        if (p.event === 'buddy.reconcile' && p.attention !== undefined) {
          if (!Array.isArray(p.attention) || p.attention.length > 32) return null
          const requests: { id: string; kind: 'permission' | 'question' }[] = []
          for (const item of p.attention) {
            if (
              !item ||
              typeof item !== 'object' ||
              !ctx.textField(item.id) ||
              !['permission', 'question'].includes(item.kind)
            )
              return null
            requests.push({ id: item.id, kind: item.kind })
          }
          result.attention = requests
        }
        break
      }
      case 'session.step.started':
      case 'session.step.ended':
      case 'session.tool.called':
      case 'session.tool.progress':
      case 'session.tool.success':
      case 'session.tool.error':
      case 'session.execution.started':
      case 'session.retry.scheduled':
        result = { status: 'working', action: 'observe', turnActive: true }
        break
      case 'session.execution.succeeded':
        result = {
          status: 'completed',
          action: 'observe',
          preserveErrorOnCompletion: true,
          turnActive: false,
        }
        break
      case 'session.execution.failed':
        result = { status: 'error', action: 'observe', turnActive: false }
        break
      case 'session.execution.interrupted':
        result = { status: 'interrupted', action: 'observe', turnActive: false }
        break
      case 'session.idle':
        result = {
          status: 'completed',
          action: 'observe',
          preserveErrorOnCompletion: true,
          turnActive: false,
        }
        break
      case 'session.error':
        result =
          p.interrupted === true
            ? { status: 'interrupted', action: 'observe', turnActive: false }
            : { status: 'error', action: 'observe' }
        break
      case 'permission.asked':
      case 'permission.v2.asked':
        result = { status: 'needs-attention', action: 'permission' }
        break
      case 'question.asked':
      case 'form.created':
        result = { status: 'needs-attention', action: 'question' }
        break
      case 'permission.replied':
      case 'permission.v2.replied':
      case 'question.replied':
      case 'question.rejected':
      case 'form.replied':
      case 'form.cancelled':
        result = { status: null, action: 'resolve' }
        break
      default:
        return null
    }
    return { ...result, name: ctx.textField(p.title) }
  },
  displayName: (ordinal) => `OpenCode ${ordinal + 1}`,
  setupCopy(kind, target) {
    if (kind === 'installed') return 'Restart OpenCode to start tracking sessions.'
    if (kind === 'removed' || kind === 'remove')
      return 'Observer removed. Restart OpenCode to finish disconnecting.'
    if (kind === 'missingCli') return 'Install this CLI, then refresh.'
    if (kind === 'unverified')
      return 'This OpenCode version is unsupported. Buddy requires OpenCode V2.'
    return `Adds a local observer at ${target}. Restart OpenCode to load it.`
  },
}
