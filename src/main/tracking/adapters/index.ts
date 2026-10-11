import { HARNESS_IDS, type HarnessId } from '../../../shared/harnesses'
import type { HarnessAdapter } from './types'
import { codex } from './codex'
import { claudeCode } from './claude-code'
import { opencode } from './opencode'

export const ADAPTERS: Record<HarnessId, HarnessAdapter> = {
  codex,
  'claude-code': claudeCode,
  opencode,
}
export const HARNESSES = HARNESS_IDS.map((id) => ADAPTERS[id])
