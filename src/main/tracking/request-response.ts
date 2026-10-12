import type { AgentRequest, AgentResponse } from '../../shared/contracts'

export function validateResponse(request: AgentRequest, value: unknown): AgentResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid response')
  if (Buffer.byteLength(JSON.stringify(value)) > 64_000)
    throw new Error('These answers are too long. Shorten them or use your agent’s window.')
  const response = value as Record<string, unknown>
  if (response.decision === 'native') return { decision: 'native' }
  if (request.kind === 'permission' && ['allow', 'reject'].includes(String(response.decision))) {
    const decision = response.decision as 'allow' | 'reject'
    if (request.allowedDecisions && !request.allowedDecisions.includes(decision))
      throw new Error('Use your agent’s window for this decision.')
    return { decision }
  }
  if (
    request.kind !== 'question' ||
    !Array.isArray(response.answers) ||
    response.answers.length !== request.questions.length
  )
    throw new Error('Invalid response for this request')
  const answers: string[][] = []
  for (const [i, value] of response.answers.entries()) {
    const question = request.questions[i]!
    if (
      !Array.isArray(value) ||
      !value.length ||
      value.length > 16 ||
      (!question.multiple && value.length !== 1) ||
      !value.every(
        (answer) =>
          typeof answer === 'string' &&
          answer.length > 0 &&
          answer.length <= 4096 &&
          (question.custom || question.options.some((option) => option.label === answer)),
      ) ||
      new Set(value).size !== value.length
    )
      throw new Error('Answer each question before submitting.')
    answers.push(value as string[])
  }
  return { answers }
}
