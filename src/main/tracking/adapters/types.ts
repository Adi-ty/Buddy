import type { HarnessId } from '../../../shared/harnesses'
import type { Observation } from '../events'

export interface EventContext {
  sessionId: string
  parentId: string | null
  textField(value: unknown, limit?: number): string | null
}
export interface EventMapping {
  status: Observation['status']
  action: Observation['action']
  attention?: Observation['attention']
  sessionId?: string
  parentId?: string | null
  name?: string | null
  turnId?: string | null
  clearPermissionHints?: boolean
  idleCompletesTurn?: boolean
  preserveErrorOnCompletion?: boolean
  turnActive?: boolean
}
export interface HarnessAdapter {
  id: HarnessId
  name: string
  shortLabel: string
  description: string
  source: 'hooks' | 'plugin'
  cli: { command: string; extraPaths: string[] }
  compat: {
    verified: string
    matches?(version: string): boolean
    supports?(version: string): boolean
    probe?(path: string, env: NodeJS.ProcessEnv): Promise<boolean>
  }
  target(ctx: { profile: string; development: boolean }): string
  installMode: 'hooks' | 'plugin'
  pluginAsset?: string
  nameIndex?: { path(): string; idField: string; nameField: string }
  nameStorage?: { kind: 'opencode-db' | 'claude-titles'; path(): string }
  hookEvents(): string[]
  mapEvent(p: Record<string, unknown>, ctx: EventContext): EventMapping | null
  displayName(identityOrdinal: number): string
  setupCopy(
    kind: 'install' | 'installed' | 'remove' | 'removed' | 'missingCli' | 'unverified',
    target: string,
  ): string
}
