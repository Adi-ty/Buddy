import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

// Correlates a tool call across hook events without sending its input.
export function inputDigest(tool, input) {
  if (typeof tool !== 'string') return undefined
  const canonical = (value) =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical(value[key])]),
          )
        : value
  return createHash('sha256')
    .update(JSON.stringify([tool, canonical(input ?? null)]))
    .digest('hex')
}

// Shared by command hooks and the OpenCode plugin. Never sends prompts, tool
// inputs/results, transcripts, permission resources or errors. OpenCode session
// titles are included only as display names.
export function metadata(value) {
  const fields = [
    'id',
    'harness',
    'event',
    'sessionId',
    'parentId',
    'agentId',
    'cwd',
    'title',
    'turnId',
    'tool',
    'requestId',
    'inputDigest',
    'notificationType',
    'status',
  ]
  const output = { version: 1, id: randomUUID(), at: Date.now() }
  for (const field of fields) {
    const raw = value[field]
    const text =
      field === 'title' && typeof raw === 'string'
        ? raw
            .replace(/[\u0000-\u001f]/g, ' ')
            .trim()
            .slice(0, 256)
        : raw
    if (
      typeof text === 'string' &&
      text.length &&
      text.length <= (field === 'cwd' ? 2048 : 256) &&
      !/[\u0000-\u001f]/.test(text)
    )
      output[field] = text
  }
  if (Number.isFinite(value.at)) output.at = value.at
  for (const field of ['toolFailed', 'interrupted'])
    if (typeof value[field] === 'boolean') output[field] = value[field]
  if (Array.isArray(value.attention) && value.attention.length <= 32)
    output.attention = value.attention.map((item) => ({ id: item.id, kind: item.kind }))
  return output
}

export function report(configPath, value) {
  return new Promise((resolve) => {
    let socket
    const done = () => {
      socket?.destroy()
      clearTimeout(deadline)
      resolve()
    }
    const deadline = setTimeout(done, 100)
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf8'))
      if (typeof config.socket !== 'string' || typeof config.token !== 'string') return done()
      socket = connect(config.socket)
      socket.once('error', done)
      socket.once('data', done)
      socket.once('close', done)
      socket.once('connect', () =>
        socket.end(JSON.stringify({ token: config.token, observation: metadata(value) }) + '\n'),
      )
    } catch {
      done()
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Bound both stdin and transport, always exit successfully with no policy
  // output. Sync hooks preserve invocation order without async teardown races.
  const started = performance.timeOrigin
  const watchdog = setTimeout(() => process.exit(0), 250)
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    input += chunk
    if (input.length > 1024 * 1024) process.exit(0)
  })
  process.stdin.on('error', () => process.exit(0))
  process.stdin.on('end', async () => {
    try {
      const p = JSON.parse(input)
      await report(process.argv[3], {
        ...(p.tool_use_id &&
        [
          'PreToolUse',
          'PostToolUse',
          'PostToolUseFailure',
          'PermissionRequest',
          'PermissionDenied',
        ].includes(p.hook_event_name)
          ? {
              id: createHash('sha256')
                .update(
                  JSON.stringify([process.argv[2], p.session_id, p.hook_event_name, p.tool_use_id]),
                )
                .digest('hex'),
            }
          : {}),
        harness: process.argv[2],
        at: started,
        event: p.hook_event_name,
        sessionId: p.session_id,
        agentId: p.agent_id,
        cwd: p.cwd,
        turnId: p.turn_id,
        tool: p.tool_name,
        requestId: p.tool_use_id,
        inputDigest:
          process.argv[2] === 'claude-code' && p.hook_event_name === 'PreToolUse'
            ? inputDigest(p.tool_name, p.tool_input)
            : undefined,
        notificationType: p.notification_type,
        toolFailed:
          p.hook_event_name === 'PostToolUse' &&
          (p.tool_response?.isError === true ||
            p.tool_response?.is_error === true ||
            (Number.isInteger(p.tool_response?.exit_code) && p.tool_response.exit_code !== 0)),
        interrupted: p.is_interrupt === true || p.tool_response?.interrupted === true,
      })
    } catch {
      /* Observation is best effort. */
    }
    clearTimeout(watchdog)
    process.exit(0)
  })
}
