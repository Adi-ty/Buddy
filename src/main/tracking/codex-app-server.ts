import { randomUUID } from 'node:crypto'
import type { AgentRequest, HarnessCatalogEntry, SessionStatus } from '../../shared/contracts'
import { textField, type Observation } from './events'
import { codexRequest, isObject, isRpcId, type CodexRequest } from './codex-request'
import { CodexRpcClient, codexSocketPath } from './codex-rpc'
import { validateResponse } from './request-response'

interface Thread {
  id: string
  cwd: string | null
  name: string | null
  parentId: string | null
  turnId: string | null
  status: SessionStatus
  heartbeat: number
  activeSeen: boolean
}
interface Pending extends CodexRequest {
  hidden: boolean
  timer?: ReturnType<typeof setTimeout>
}
const requestKey = (thread: string, id: unknown) => JSON.stringify([thread, id])
const itemKey = (thread: string, id: string) => JSON.stringify([thread, id])

export class CodexAppServer {
  private enabled = false
  private generation = 0
  private client: CodexRpcClient | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private polling = false
  private readonly threads = new Map<string, Thread>()
  private readonly subscribing = new Set<string>()
  private readonly retryThreads = new Map<string, number>()
  private readonly items = new Map<string, Record<string, unknown>>()
  private readonly pending = new Map<string, Pending>()
  private connection: NonNullable<HarnessCatalogEntry['controlsConnection']> = 'disabled'
  constructor(
    private readonly options: {
      changed: () => void
      observed: (event: Observation) => void
      resolved: (
        sessionId: string,
        requestId: string,
        tool: string | null,
        turnId: string,
        allowed: boolean,
      ) => void
      socketPath?: () => string
    },
  ) {}
  state(): Pick<HarnessCatalogEntry, 'controlsConnection' | 'controlsMessage'> {
    return {
      controlsConnection: this.connection,
      controlsMessage:
        this.connection === 'connected'
          ? 'Native replies connected. Answer in Codex or Buddy; both update together.'
          : this.connection === 'connecting'
            ? 'Connecting to Codex’s local app server…'
            : this.connection === 'unavailable'
              ? 'Waiting for Codex’s local app server. Replies stay in Codex until it connects.'
              : 'Enable replies to connect to Codex’s local app server.',
    }
  }
  private setState(state: typeof this.connection): void {
    if (state === this.connection) return
    this.connection = state
    this.options.changed()
  }
  configure(enabled: boolean): void {
    if (enabled === this.enabled) return
    this.enabled = enabled
    if (enabled) void this.connect()
    else this.dispose()
  }
  snapshot(): AgentRequest[] {
    return [...this.pending.values()]
      .filter((request) => !request.hidden)
      .map((request) => ({ ...request.view }))
  }
  owns(id: unknown): boolean {
    return [...this.pending.values()].some((request) => request.view.id === id)
  }
  async respond(id: unknown, value: unknown): Promise<void> {
    const request = [...this.pending.values()].find((request) => request.view.id === id)
    if (!request || request.hidden || !this.enabled || !this.client?.connected)
      throw new Error('This request has ended. Check Codex for its current state.')
    const response = validateResponse(request.view, value)
    if ('decision' in response && response.decision === 'native') {
      request.hidden = true
      this.options.changed()
      return // Never send a second decision or dismiss the native prompt.
    }
    if (request.view.submitting) throw new Error('A response is already being sent.')
    // A WebSocket write is not a source acknowledgment. Keep it pending until
    // the exact serverRequest/resolved notification arrives on this connection.
    this.client.respond(request.rpcId, request.result(response))
    request.view = { ...request.view, submitting: true, error: null }
    request.timer = setTimeout(() => {
      request.view = {
        ...request.view,
        error: 'Codex hasn’t confirmed this response. Check its window before continuing.',
      }
      this.options.changed()
    }, 8000)
    this.options.changed()
  }
  private async connect(): Promise<void> {
    if (!this.enabled) return
    const generation = ++this.generation
    this.setState('connecting')
    try {
      const client = new CodexRpcClient(
        this.options.socketPath?.() ?? codexSocketPath(),
        (message) => {
          if (this.generation === generation) this.receive(message)
        },
        () => {
          if (this.generation === generation) this.lost()
        },
      )
      this.client = client
      await client.open()
      if (generation !== this.generation) return
      await this.poll()
      if (generation !== this.generation) return
      this.setState('connected')
    } catch {
      if (generation === this.generation) this.lost()
    }
  }
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    if (!this.enabled) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.client?.connected) void this.poll().catch(() => this.lost())
      else void this.connect()
    }, 5000)
    this.timer.unref?.()
  }
  private lost(): void {
    ++this.generation
    const client = this.client
    this.client = null
    client?.close()
    this.polling = false
    for (const key of this.pending.keys()) this.retire(key, false)
    this.threads.clear()
    this.subscribing.clear()
    this.retryThreads.clear()
    this.items.clear()
    this.setState(this.enabled ? 'unavailable' : 'disabled')
    this.schedule()
  }
  private async poll(): Promise<void> {
    if (this.polling || !this.client?.connected) return
    this.polling = true
    const client = this.client
    try {
      const loaded = new Set<string>()
      let cursor: string | undefined
      do {
        const response = await client.call('thread/loaded/list', {
          limit: 100,
          ...(cursor ? { cursor } : {}),
        })
        if (!Array.isArray(response.data) || !response.data.every((id) => textField(id, 128)))
          throw new Error('Invalid loaded-thread list')
        for (const id of response.data) loaded.add(id as string)
        const next = textField(response.nextCursor, 1024)
        if (next && next === cursor) throw new Error('Invalid thread cursor')
        cursor = next ?? undefined
      } while (cursor && loaded.size < 256)
      if (this.client !== client) return
      for (const id of loaded) {
        if (this.client !== client) return
        if (
          !this.threads.has(id) &&
          this.threads.size < 256 &&
          Date.now() >= (this.retryThreads.get(id) ?? 0)
        ) {
          this.subscribing.add(id)
          // Only attach to a currently loaded runtime. No stored thread is
          // intentionally reopened, no turn is started, and no config is changed.
          try {
            const read = await client.call('thread/read', { threadId: id, includeTurns: false })
            if (
              isObject(read.thread) &&
              isObject(read.thread.status) &&
              read.thread.status.type !== 'notLoaded'
            ) {
              this.metadata(read.thread)
              const response = await client.call('thread/resume', {
                threadId: id,
                excludeTurns: true,
              })
              if (isObject(response.thread)) this.metadata(response.thread)
            }
          } catch {
            if (!client.connected) throw new Error('Codex disconnected.')
            // Ephemeral/internal runtimes can appear in loaded/list without a
            // resumable rollout. They must not disconnect every other session.
            this.retireThread(id)
            this.threads.delete(id)
            this.retryThreads.set(id, Date.now() + 60_000)
          } finally {
            this.subscribing.delete(id)
          }
        }
        const thread = this.threads.get(id)
        if (thread?.activeSeen && Date.now() - thread.heartbeat > 60_000)
          this.observe(thread, 'AppServerHeartbeat', null)
      }
      for (const [id, thread] of this.threads)
        if (!loaded.has(id)) {
          this.retireThread(id)
          this.observe(thread, 'AppServerDetached', 'unknown', 'close')
          this.threads.delete(id)
        }
      for (const id of this.retryThreads.keys()) if (!loaded.has(id)) this.retryThreads.delete(id)
    } finally {
      this.polling = false
      if (this.client === client) this.schedule()
    }
  }
  private metadata(value: Record<string, unknown>): void {
    const id = textField(value.id, 128)
    if (!id || (!this.subscribing.has(id) && !this.threads.has(id))) return
    const previous = this.threads.get(id)
    const thread: Thread = {
      id,
      cwd: textField(value.cwd, 2048),
      name: textField(value.name) ?? textField(value.agentNickname),
      parentId: textField(value.parentThreadId, 128),
      turnId: previous?.turnId ?? null,
      status: previous?.status ?? 'unknown',
      heartbeat: previous?.heartbeat ?? 0,
      activeSeen: previous?.activeSeen ?? false,
    }
    this.threads.set(id, thread)
    this.status(thread, value.status)
  }
  private status(thread: Thread, value: unknown): void {
    if (!isObject(value)) return
    let status: SessionStatus
    if (value.type === 'active') {
      thread.activeSeen = true
      const flags = Array.isArray(value.activeFlags) ? value.activeFlags : []
      status = flags.some((flag) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput')
        ? 'needs-attention'
        : 'working'
    } else if (value.type === 'idle') {
      if (!thread.activeSeen) {
        this.observe(thread, 'AppServerMetadata', null, 'metadata')
        return
      }
      status = ['completed', 'error', 'interrupted'].includes(thread.status)
        ? thread.status
        : ['working', 'needs-attention'].includes(thread.status)
          ? 'completed'
          : 'idle'
    } else if (value.type === 'systemError') status = 'error'
    else return
    thread.status = status
    this.observe(thread, 'AppServerState', status)
  }
  private observe(
    thread: Thread,
    event: string,
    status: SessionStatus | null,
    action: Observation['action'] = 'observe',
    tool: string | null = null,
    requestId: string | null = null,
  ): void {
    thread.heartbeat = Date.now()
    this.options.observed({
      id: randomUUID(),
      harness: 'codex',
      source: 'app-server',
      sessionId: thread.id,
      parentId: thread.parentId,
      cwd: thread.cwd,
      name: thread.name,
      turnId: thread.turnId,
      event,
      at: thread.heartbeat,
      status,
      action,
      tool,
      requestId,
      attention: null,
    })
  }
  private receive(message: Record<string, unknown>): void {
    const method = message.method
    const params = message.params
    if (typeof method !== 'string' || !isObject(params)) return
    if (method === 'thread/started') {
      // Discovery through loaded/list is deliberate: thread/started can also be
      // sent for other clients and must not hydrate arbitrary historical threads.
      if (isObject(params.thread)) this.metadata(params.thread)
      return
    }
    const id = textField(params.threadId, 128)
    if (!id || !this.threads.has(id)) return
    const thread = this.threads.get(id)!
    if (isRpcId(message.id)) {
      const key = requestKey(id, message.id)
      if (this.pending.has(key) || this.pending.size >= 64) return
      const parsed = codexRequest(
        message.id,
        method,
        params,
        this.items.get(itemKey(id, String(params.itemId))),
      )
      if (!parsed) return // Native UI retains all unsupported requests.
      if (thread.turnId !== parsed.turnId) {
        this.retireThread(id)
        thread.turnId = parsed.turnId
        this.observe(thread, 'UserPromptSubmit', 'working')
      }
      const request: Pending = {
        ...parsed,
        view: { ...parsed.view, id: randomUUID() },
        hidden: false,
      }
      thread.activeSeen = true
      this.pending.set(key, request)
      this.observe(
        thread,
        'NativeInputRequest',
        'needs-attention',
        request.view.kind,
        request.view.tool,
        request.view.id,
      )
      this.options.changed()
    } else if (method === 'serverRequest/resolved' && isRpcId(params.requestId)) {
      this.retire(requestKey(id, params.requestId), true)
    } else if (method === 'thread/status/changed') this.status(thread, params.status)
    else if (method === 'thread/name/updated') {
      thread.name = textField(params.threadName) ?? textField(params.name)
      this.observe(thread, 'AppServerMetadata', null, 'metadata')
    } else if (method === 'turn/started' && isObject(params.turn)) {
      const turnId = textField(params.turn.id, 128)
      if (!turnId) return
      this.retireThread(id)
      thread.turnId = turnId
      thread.activeSeen = true
      thread.status = 'working'
      this.observe(thread, 'UserPromptSubmit', 'working')
    } else if (method === 'turn/completed' && isObject(params.turn)) {
      if (!['completed', 'failed', 'interrupted'].includes(String(params.turn.status))) return
      if (thread.turnId && thread.turnId !== params.turn.id) return
      this.retireThread(id)
      thread.status =
        params.turn.status === 'failed'
          ? 'error'
          : params.turn.status === 'interrupted'
            ? 'interrupted'
            : 'completed'
      this.observe(thread, thread.status === 'completed' ? 'Stop' : 'Interrupt', thread.status)
    } else if (
      method === 'thread/closed' ||
      method === 'thread/archived' ||
      method === 'thread/deleted'
    ) {
      this.retireThread(id)
      this.observe(thread, 'AppServerDetached', 'unknown', 'close')
      this.threads.delete(id)
    } else if (
      (method === 'item/started' || method === 'item/completed') &&
      isObject(params.item)
    ) {
      const item = params.item
      const itemId = textField(item.id, 256)
      if (!itemId) return
      if (
        method === 'item/started' &&
        item.type === 'fileChange' &&
        this.items.size < 64 &&
        Buffer.byteLength(JSON.stringify(item)) <= 64_000
      )
        this.items.set(itemKey(id, itemId), item)
      if (method === 'item/completed') {
        for (const [key, request] of this.pending)
          if (request.threadId === id && request.itemId === itemId)
            this.retire(key, item.status !== 'declined')
        this.items.delete(itemKey(id, itemId))
      }
      const tool =
        item.type === 'commandExecution'
          ? 'Bash'
          : item.type === 'fileChange'
            ? 'File changes'
            : null
      if (tool)
        this.observe(
          thread,
          method === 'item/started' ? 'NativeToolStarted' : 'NativeToolCompleted',
          null,
          'observe',
          tool,
        )
    }
  }
  private retire(key: string, allowed: boolean): void {
    const request = this.pending.get(key)
    if (!request) return
    if (request.timer) clearTimeout(request.timer)
    this.pending.delete(key)
    this.options.resolved(
      `codex:${request.threadId}`,
      request.view.id,
      request.view.tool,
      request.turnId,
      allowed,
    )
    this.options.changed()
  }
  private retireThread(id: string): void {
    for (const [key, request] of this.pending) if (request.threadId === id) this.retire(key, false)
    for (const key of this.items.keys())
      if (key.startsWith(`[${JSON.stringify(id)},`)) this.items.delete(key)
  }
  dispose(): void {
    this.enabled = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.lost()
  }
}
