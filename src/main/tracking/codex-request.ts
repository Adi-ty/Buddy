import type { AgentQuestion, AgentRequest, AgentResponse } from '../../shared/contracts'
import { textField } from './events'

export const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
export type RpcId = string | number
export const isRpcId = (value: unknown): value is RpcId =>
  typeof value === 'string' ? !!textField(value, 256) : Number.isSafeInteger(value)

function reviewDetails(params: Record<string, unknown>): Record<string, unknown> {
  const routing = new Set([
    'threadId',
    'turnId',
    'itemId',
    'approvalId',
    'startedAtMs',
    'availableDecisions',
  ])
  const ordered = ['command', 'reason', 'cwd', ...Object.keys(params)]
  return Object.fromEntries(
    [...new Set(ordered)]
      .filter((key) => !routing.has(key) && params[key] !== undefined && params[key] !== null)
      .map((key) => [key, params[key]]),
  )
}

export interface CodexRequest {
  rpcId: RpcId
  threadId: string
  turnId: string
  itemId: string
  view: AgentRequest
  result: (response: AgentResponse) => unknown
}

// Only supported native requests become actionable. Never abbreviate command
// permissions or patches to fit an approval preview.
export function codexRequest(
  id: RpcId,
  method: string,
  params: Record<string, unknown>,
  item?: Record<string, unknown>,
): (Omit<CodexRequest, 'view'> & { view: Omit<AgentRequest, 'id'> }) | null {
  const threadId = textField(params.threadId, 128)
  const turnId = textField(params.turnId, 128)
  const itemId = textField(params.itemId, 256)
  if (!threadId || !turnId || !itemId) return null
  const questions: AgentQuestion[] = []
  let tool: string
  let result: CodexRequest['result']
  let allowedDecisions: ('allow' | 'reject')[] | undefined
  let allowLabel: string | undefined
  let details: string
  if (method === 'item/tool/requestUserInput') {
    if (!Array.isArray(params.questions) || !params.questions.length || params.questions.length > 8)
      return null
    const ids: string[] = []
    for (const value of params.questions) {
      if (!isObject(value) || value.isSecret === true) return null
      const questionId = textField(value.id, 256)
      if (!questionId || ids.includes(questionId)) return null
      ids.push(questionId)
      if (typeof value.question !== 'string' || !value.question || value.question.length > 4096)
        return null
      const options = value.options ?? []
      if (
        !Array.isArray(options) ||
        options.length > 16 ||
        !options.every(
          (option) =>
            isObject(option) &&
            textField(option.label, 256) &&
            typeof option.description === 'string' &&
            option.description.length <= 2048,
        ) ||
        new Set(options.map((option) => option.label)).size !== options.length
      )
        return null
      questions.push({
        text: value.question,
        header: typeof value.header === 'string' ? value.header.slice(0, 128) : '',
        multiple: false,
        custom: !options.length || value.isOther === true,
        options: options as AgentQuestion['options'],
      })
    }
    tool = 'Question'
    details = 'Codex needs your answer.'
    result = (response) => {
      if (!('answers' in response)) throw new Error('Invalid question response')
      return {
        answers: Object.fromEntries(ids.map((key, i) => [key, { answers: response.answers[i] }])),
      }
    }
  } else if (method === 'item/commandExecution/requestApproval') {
    if (!params.networkApprovalContext && (typeof params.command !== 'string' || !params.command))
      return null
    tool = params.networkApprovalContext
      ? 'Network access'
      : params.kind === 'stdin'
        ? 'Terminal input'
        : 'Bash'
    details = JSON.stringify(reviewDetails(params), null, 2)
    const decisions = params.availableDecisions
    if (decisions !== undefined && decisions !== null) {
      if (!Array.isArray(decisions)) return null
      allowedDecisions = []
      if (decisions.includes('accept')) allowedDecisions.push('allow')
      if (decisions.includes('decline')) allowedDecisions.push('reject')
    }
    result = (response) => {
      if (!('decision' in response)) throw new Error('Invalid approval response')
      return { decision: response.decision === 'allow' ? 'accept' : 'decline' }
    }
  } else if (method === 'item/fileChange/requestApproval') {
    // Late attachment may replay an approval without its item/started patch.
    // Leave that decision in Codex rather than approving unseen changes.
    if (!item || item.type !== 'fileChange' || !Array.isArray(item.changes)) return null
    tool = 'File changes'
    details = JSON.stringify({ ...reviewDetails(params), changes: item.changes }, null, 2)
    result = (response) => {
      if (!('decision' in response)) throw new Error('Invalid approval response')
      return { decision: response.decision === 'allow' ? 'accept' : 'decline' }
    }
  } else if (method === 'item/permissions/requestApproval') {
    if (!isObject(params.permissions)) return null
    tool = 'Permissions'
    allowLabel = 'Allow for this turn'
    details = JSON.stringify({ ...reviewDetails(params), scope: 'turn' }, null, 2)
    result = (response) => {
      if (!('decision' in response)) throw new Error('Invalid permission response')
      return { permissions: response.decision === 'allow' ? params.permissions : {}, scope: 'turn' }
    }
  } else return null
  if (Buffer.byteLength(details) > 64_000) return null
  return {
    rpcId: id,
    threadId,
    turnId,
    itemId,
    result,
    view: {
      sessionId: `codex:${threadId}`,
      harness: 'codex',
      kind: questions.length ? 'question' : 'permission',
      tool,
      details,
      questions,
      createdAt: Date.now(),
      expiresAt: Number.MAX_SAFE_INTEGER,
      submitting: false,
      error: null,
      allowedDecisions,
      allowLabel,
      mirrored: true,
    },
  }
}
