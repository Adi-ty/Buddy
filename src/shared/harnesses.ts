export const HARNESS_IDS = ['codex', 'claude-code', 'opencode'] as const
export type HarnessId = (typeof HARNESS_IDS)[number]

export function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === 'string' && HARNESS_IDS.some((id) => id === value)
}
