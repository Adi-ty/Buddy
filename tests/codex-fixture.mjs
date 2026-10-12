import { createServer } from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, rmSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import WebSocket, { WebSocketServer } from 'ws'

// A native client and Buddy subscribe to the same fixture runtime. The fixture
// broadcasts one server request and accepts only the first matching response.
export async function codexFixture(socketPath, threadId = 'native-thread') {
  const socketDirectory = mkdtempSync(
    join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'buddy-ws-'),
  )
  const endpoint = join(socketDirectory, 'codex.sock')
  const http = createServer()
  const wss = new WebSocketServer({ server: http })
  const peers = new Map()
  const requests = new Map()
  const calls = []
  const decisions = []
  const threads = new Map([
    [
      threadId,
      {
        id: threadId,
        cwd: '/projects/native fixture',
        name: 'Native Codex task',
        parentThreadId: null,
        status: { type: 'active', activeFlags: [] },
        turns: [],
        preview: 'PRIVATE CONVERSATION: never persist this',
      },
    ],
  ])
  let autoResolve = true
  const key = (id) => JSON.stringify(id)
  const send = (peer, message) => {
    if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify(message))
  }
  const broadcast = (thread, message) => {
    for (const [peer, state] of peers) if (state.subscriptions.has(thread)) send(peer, message)
  }
  const resolveRequest = (id) => {
    const request = requests.get(key(id))
    if (!request) return
    requests.delete(key(id))
    broadcast(request.params.threadId, {
      method: 'serverRequest/resolved',
      params: { threadId: request.params.threadId, requestId: id },
    })
  }
  wss.on('connection', (peer) => {
    const state = { name: null, subscriptions: new Set() }
    peers.set(peer, state)
    peer.on('close', () => peers.delete(peer))
    peer.on('message', (bytes) => {
      const message = JSON.parse(bytes)
      if (!message.method) {
        const request = requests.get(key(message.id))
        if (!request || !state.subscriptions.has(request.params.threadId) || request.answered)
          return
        request.answered = true
        decisions.push({ id: message.id, result: message.result, client: state.name })
        if (autoResolve) resolveRequest(message.id)
        return
      }
      calls.push({ ...message, client: state.name })
      let result = {}
      if (message.method === 'initialize') state.name = message.params.clientInfo.name
      else if (message.method === 'thread/loaded/list')
        result = { data: [...threads.keys()], nextCursor: null }
      else if (message.method === 'thread/read')
        result = { thread: threads.get(message.params.threadId) }
      else if (message.method === 'thread/resume') {
        if (threads.get(message.params.threadId)?.resumeUnavailable) {
          send(peer, { id: message.id, error: { code: -32600, message: 'no rollout found' } })
          return
        }
        state.subscriptions.add(message.params.threadId)
        result = { thread: threads.get(message.params.threadId) }
        for (const request of requests.values())
          if (request.params.threadId === message.params.threadId)
            send(peer, { id: request.id, method: request.method, params: request.params })
      } else if (message.method !== 'initialized') {
        throw new Error('Unexpected client mutation: ' + message.method)
      }
      if (message.id !== undefined) send(peer, { id: message.id, result })
    })
  })
  mkdirSync(dirname(socketPath), { recursive: true })
  const close = async () => {
    for (const peer of peers.keys()) peer.terminate()
    await new Promise((resolve) => wss.close(resolve))
    if (http.listening) await new Promise((resolve) => http.close(resolve))
    rmSync(socketDirectory, { recursive: true, force: true })
  }
  try {
    await new Promise((resolve, reject) => {
      http.once('error', reject)
      http.listen(endpoint, () => {
        http.removeListener('error', reject)
        resolve()
      })
    })
    chmodSync(endpoint, 0o600)
    symlinkSync(endpoint, socketPath)
  } catch (error) {
    await close()
    throw error
  }
  return {
    socketPath,
    threads,
    requests,
    calls,
    decisions,
    broadcast,
    resolveRequest,
    holdResolution: () => {
      autoResolve = false
    },
    ask(id, method = 'item/commandExecution/requestApproval', extra = {}) {
      const params = {
        threadId,
        turnId: 'native-turn',
        itemId: 'native-item',
        command: 'echo native approval',
        cwd: '/projects/native fixture',
        reason: 'Confirm the command',
        ...extra,
      }
      requests.set(key(id), { id, method, params, answered: false })
      broadcast(params.threadId, { id, method, params })
    },
    async nativeClient() {
      const peer = new WebSocket(`ws+unix:${endpoint}:/`)
      const messages = []
      peer.on('message', (bytes) => messages.push(JSON.parse(bytes)))
      await new Promise((resolve, reject) => {
        peer.once('open', resolve)
        peer.once('error', reject)
      })
      send(peer, {
        id: 'native-init',
        method: 'initialize',
        params: { clientInfo: { name: 'native' } },
      })
      send(peer, { method: 'initialized' })
      send(peer, {
        id: 'native-subscribe',
        method: 'thread/resume',
        params: { threadId, excludeTurns: true },
      })
      return { peer, messages, respond: (id, result) => send(peer, { id, result }) }
    },
    disconnectBuddy() {
      for (const [peer, state] of peers) if (state.name === 'buddy') peer.terminate()
    },
    async close() {
      await close()
      unlinkSync(socketPath)
    },
  }
}
