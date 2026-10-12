import { randomUUID } from 'node:crypto'
import { connectControls } from './control-client.mjs'
import { pathToFileURL } from 'node:url'

export function hookRequest(harness, input, id = randomUUID()) {
  // Older Codex configurations can still invoke this file. Never intercept its
  // approval: Buddy now mirrors the request from the native app-server stream.
  if (harness !== 'claude-code' || typeof input.session_id !== 'string') return null
  const question =
    harness === 'claude-code' &&
    input.hook_event_name === 'PreToolUse' &&
    input.tool_name === 'AskUserQuestion'
  if (!question && input.hook_event_name !== 'PermissionRequest') return null
  if (
    question &&
    (!Array.isArray(input.tool_input?.questions) || !input.tool_input.questions.length)
  )
    return null
  const details = question
    ? 'Your agent needs an answer to continue.'
    : JSON.stringify(input.tool_input ?? {}, null, 2)
  if (details.length > 64_000) return null // Never approve from a truncated preview.
  const child =
    harness === 'claude-code' &&
    typeof input.agent_id === 'string' &&
    input.agent_id !== input.session_id
      ? input.agent_id
      : null
  return {
    op: 'request',
    id,
    hook: true,
    sessionId: child ?? input.session_id,
    ...(child ? { parentId: input.session_id } : {}),
    cwd: input.cwd,
    turnId: input.turn_id,
    tool: input.tool_name,
    kind: question ? 'question' : 'permission',
    details,
    ...(question
      ? {
          questions: input.tool_input.questions.map((q) => ({
            text: q.question,
            header: q.header ?? '',
            multiple: q.multiSelect === true,
            custom: true,
            options: q.options.map((o) => ({ label: o.label, description: o.description ?? '' })),
          })),
        }
      : {}),
  }
}

export function hookOutput(input, response) {
  if (response.decision === 'native') return null
  if (
    input.hook_event_name === 'PermissionRequest' &&
    ['allow', 'reject'].includes(response.decision)
  )
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: response.decision === 'allow' ? 'allow' : 'deny',
          ...(response.decision === 'reject' ? { message: 'Denied by the user in Buddy.' } : {}),
        },
      },
    }
  if (input.tool_name === 'AskUserQuestion' && Array.isArray(response.answers))
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: {
          ...input.tool_input,
          questions: input.tool_input.questions,
          answers: Object.fromEntries(
            input.tool_input.questions.map((q, i) => [q.question, response.answers[i].join(', ')]),
          ),
        },
      },
    }
  return null
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const harness = process.argv[2]
  let input = ''
  let channel
  let finalOutput = null
  let published = false
  let finished = false
  const finish = (output) => {
    if (finished) return
    finished = true
    clearTimeout(deadline)
    clearInterval(heartbeat)
    channel?.close()
    if (output) process.stdout.write(JSON.stringify(output) + '\n', () => process.exit(0))
    else process.exit(0)
  }
  const deadline = setTimeout(() => finish(null), 121_000)
  const heartbeat = setInterval(() => channel?.send({ op: 'ping' }), 15_000)
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    input += chunk
    if (input.length > 1024 * 1024) finish(null)
  })
  process.stdin.on('error', () => finish(null))
  process.stdin.on('end', () => {
    try {
      const payload = JSON.parse(input)
      const request = hookRequest(harness, payload)
      if (!request) return finish(null)
      const handshake = setTimeout(() => finish(null), 500)
      channel = connectControls(
        process.argv[3],
        harness,
        (message) => {
          if (message.op === 'ready') {
            clearTimeout(handshake)
            if (message.enabled !== true) return finish(null)
            if (!published) {
              published = true
              channel.send(request)
            }
          } else if (message.op === 'reply' && message.id === request.id) {
            finalOutput = hookOutput(payload, message.response)
            // Ack only the response for this invocation. Other hooks retain their
            // authority and may still deny it under the harness's precedence rules.
            channel.send({ op: 'result', id: request.id, ok: true })
            setTimeout(() => finish(finalOutput), 20)
          } else if (message.op === 'retired' && message.id === request.id) finish(finalOutput)
          else if (message.op === 'disabled') finish(null)
        },
        () => finish(finalOutput),
      )
    } catch {
      finish(null)
    }
  })
}
