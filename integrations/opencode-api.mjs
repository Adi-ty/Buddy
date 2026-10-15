import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// V2.0.29's plugin context omits active-session and form APIs. Only use the
// registered HTTP service when it belongs to this plugin's hosting process.
// Standalone/custom servers without this registration keep native form replies.
export function serviceEndpoint() {
  const file = join(
    process.env.XDG_STATE_HOME || join(homedir(), '.local/state'),
    'opencode/service.json',
  )
  const info = JSON.parse(readFileSync(file, 'utf8'))
  const url = new URL(info.url)
  if (
    info.pid !== process.pid ||
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('OpenCode service does not belong to this plugin')
  return {
    url: url.origin,
    headers:
      typeof info.password === 'string'
        ? { authorization: 'Basic ' + Buffer.from(`opencode:${info.password}`).toString('base64') }
        : {},
  }
}

export async function apiJson(path, signal, body) {
  const endpoint = serviceEndpoint()
  const response = await fetch(endpoint.url + path, {
    signal,
    redirect: 'error',
    headers: { ...endpoint.headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
  })
  if (!response.ok) throw new Error('OpenCode request failed')
  if (response.status === 204) return undefined
  const result = await response.json()
  return result.data ?? result
}
