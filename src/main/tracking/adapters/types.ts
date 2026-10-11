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
}
export interface HarnessAdapter {
  id: HarnessId
  name: string
  shortLabel: string
  description: string
  source: 'hooks' | 'plugin'
  cli: { command: string; extraPaths: string[] }
  compat: { verified: string; probe?(path: string): Promise<boolean> }
  target(ctx: { profile: string; development: boolean }): string
  installMode: 'hooks' | 'plugin'
  pluginAsset?: string
  nameIndex?: { path(): string; idField: string; nameField: string }
  hookEvents(): string[]
  mapEvent(p: Record<string, unknown>, ctx: EventContext): EventMapping | null
  displayName(identityOrdinal: number): string
  setupCopy(
    kind: 'install' | 'installed' | 'remove' | 'removed' | 'missingCli' | 'unverified',
    target: string,
  ): string
}
