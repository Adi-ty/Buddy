import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { socketDirectory } from './socket-directory'
import type {
  AgentQuestion,
  AgentRequest,
  AgentResponse,
  HarnessId,
  SessionRecord,
} from '../../shared/contracts'
import { isHarnessId } from '../../shared/harnesses'
import { validateResponse } from './request-response'
import type { Observation } from './events'
import { runTask } from '../tasks'
import type { RequestOutcome } from '../request-service'

const object = (p: unknown): p is Record<string, unknown> =>
  !!p && typeof p === 'object' && !Array.isArray(p)
const text = (p: unknown, limit: number): p is string =>
  typeof p === 'string' && p.length > 0 && p.length <= limit
export const HOOK_WINDOW = 600_000
interface Pending {
  view: AgentRequest
  owner: Socket
  sourceId: string
  providerId: string
  turnId: string | null
  timer: ReturnType<typeof setTimeout>
  response?: AgentResponse
  hook: boolean
  inputDigest: string | null
  toolUseId: string | null
}
interface ToolUse {
  id: string
  inputDigest: string
  at: number
}
export interface RequestContext {
  harness: HarnessId
  providerId: string
  turnId: string | null
  tool: string | null
  sourceId: string
  cwd: string | null
  kind: 'permission' | 'question'
}

// Pending input is memory-only. Each response belongs to the authenticated
// source connection that published it, not a session name or a guessed port.
export class RequestBridge {
  private readonly token = randomBytes(32).toString('hex')
  private readonly server: Server
  private readonly sockets = new Set<Socket>()
  private readonly pending = new Map<string, Pending>()
  private readonly toolUses = new Map<string, ToolUse[]>()
  private readonly socketPath: string
  constructor(
    private readonly profile: string,
    private readonly enabled: (harness: HarnessId) => boolean,
    private readonly changed: () => void,
    private readonly observed: (context: RequestContext) => void,
    private readonly resolved: (
      context: RequestContext,
      decision: 'allow' | 'reject' | 'native',
    ) => void,
    private readonly lifecycle: (
      id: string,
      outcome: RequestOutcome | 'rejected',
    ) => void = () => {},
  ) {
    this.socketPath = join(socketDirectory(profile), 'controls.sock')
    this.server = createServer((socket) => this.accept(socket))
  }
  async start(): Promise<void> {
    mkdirSync(this.profile, { recursive: true, mode: 0o700 })
    mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 })
    const directory = lstatSync(dirname(this.socketPath))
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      directory.uid !== process.getuid?.()
    )
      throw new Error('Unsafe controls directory')
    chmodSync(dirname(this.socketPath), 0o700)
    try {
      const stat = lstatSync(this.socketPath)
      if (!stat.isSocket() || stat.uid !== process.getuid?.())
        throw new Error('Unsafe controls socket')
      unlinkSync(this.socketPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.socketPath, () => {
        this.server.removeListener('error', reject)
        resolve()
      })
    })
    this.server.on('error', () => this.dispose())
    chmodSync(this.socketPath, 0o600)
    const temporary = join(this.profile, 'controls.json.tmp')
    writeFileSync(
      temporary,
      JSON.stringify({ version: 1, socket: this.socketPath, token: this.token }),
      { mode: 0o600 },
    )
    chmodSync(temporary, 0o600)
    renameSync(temporary, join(this.profile, 'controls.json'))
  }
  snapshot(): AgentRequest[] {
    return [...this.pending.values()].map((p) => ({ ...p.view }))
  }
  private send(socket: Socket, p: unknown): void {
    if (!socket.destroyed && socket.writableLength < 256_000) socket.write(JSON.stringify(p) + '\n')
    else socket.destroy()
  }
  private context(p: Pending): RequestContext {
    return {
      harness: p.view.harness,
      providerId: p.providerId,
      turnId: p.turnId,
      sourceId: p.sourceId,
      tool: p.view.tool,
      cwd: null,
      kind: p.view.kind,
    }
  }
  private finish(
    id: string,
    decision: 'allow' | 'reject' | 'native',
    notify = true,
    outcome: RequestOutcome = 'unavailable',
  ): void {
    const p = this.pending.get(id)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(id)
    this.lifecycle(id, outcome)
    runTask('Request resolution', () => this.resolved(this.context(p), decision))
    if (notify) this.send(p.owner, { op: 'retired', id: p.sourceId })
    runTask('Request publish', this.changed)
  }
  cancel(harness: HarnessId): void {
    for (const [id, p] of this.pending)
      if (p.view.harness === harness) {
        this.send(p.owner, { op: 'reply', id: p.sourceId, response: { decision: 'native' } })
        this.finish(id, 'native')
      }
  }
  reconcile(records: readonly SessionRecord[]): void {
    for (const [id, p] of this.pending) {
      const session = records.find((r) => r.id === p.view.sessionId)
      if (
        !session ||
        session.presence !== 'observed' ||
        (p.turnId && session.turnId && p.turnId !== session.turnId) ||
        ['completed', 'interrupted'].includes(session.status)
      ) {
        this.send(p.owner, { op: 'reply', id: p.sourceId, response: { decision: 'native' } })
        this.finish(id, 'native')
      }
    }
  }
  // Claude's PermissionRequest lacks a tool-use ID; bind it through the
  // preceding PreToolUse so the call's PostToolUse retires a native answer.
  observeTool(event: Observation): void {
    if (!this.enabled(event.harness)) return
    const session = `${event.harness}:${event.sessionId}`
    if (event.event === 'PreToolUse' && event.requestId && event.inputDigest) {
      const unbound = [...this.pending.values()].find(
        (p) => p.view.sessionId === session && !p.toolUseId && p.inputDigest === event.inputDigest,
      )
      if (unbound) {
        unbound.toolUseId = event.requestId
        return
      }
      const now = Date.now()
      const recent = (this.toolUses.get(session) ?? []).filter((use) => now - use.at < HOOK_WINDOW)
      this.toolUses.delete(session)
      this.toolUses.set(
        session,
        [...recent, { id: event.requestId, inputDigest: event.inputDigest, at: now }].slice(-32),
      )
      if (this.toolUses.size > 64) this.toolUses.delete(this.toolUses.keys().next().value!)
    } else if (
      ['PostToolUse', 'PostToolUseFailure', 'PermissionDenied'].includes(event.event) &&
      event.requestId
    ) {
      const recent = this.toolUses.get(session)?.filter((use) => use.id !== event.requestId)
      if (recent?.length) this.toolUses.set(session, recent)
      else this.toolUses.delete(session)
      for (const [id, p] of this.pending)
        if (p.view.sessionId === session && p.toolUseId === event.requestId)
          this.finish(id, 'native')
    }
  }
  private claimToolUse(session: string, inputDigest: string | null): string | null {
    const recent = this.toolUses.get(session) ?? []
    const index = recent.findIndex((use) => use.inputDigest === inputDigest)
    if (!inputDigest || index < 0) return null
    const [use] = recent.splice(index, 1)
    if (!recent.length) this.toolUses.delete(session)
    return use!.id
  }
  async respond(id: unknown, response: unknown): Promise<void> {
    const p = typeof id === 'string' ? this.pending.get(id) : undefined
    if (!p || Date.now() >= p.view.expiresAt || p.owner.destroyed || !this.enabled(p.view.harness))
      throw new Error('This request has ended. Check your agent for its current state.')
    if (p.view.submitting) throw new Error('A response is already being sent.')
    const answer = validateResponse(p.view, response)
    p.response = answer
    p.view = { ...p.view, submitting: true, error: null }
    this.send(p.owner, { op: 'reply', id: p.sourceId, response: answer })
    this.changed()
  }
  private accept(socket: Socket): void {
    if (this.sockets.size >= 32) {
      socket.destroy()
      return
    }
    this.sockets.add(socket)
    let authenticated = false
    let harness: HarnessId | null = null
    let input = ''
    socket.setEncoding('utf8')
    socket.setTimeout(10_000, () => socket.destroy())
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      this.sockets.delete(socket)
      for (const [id, p] of this.pending) if (p.owner === socket) this.finish(id, 'native', false)
    })
    socket.on('data', (chunk: string) => {
      input += chunk
      if (Buffer.byteLength(input) > 256_000) {
        socket.destroy()
        return
      }
      while (input.includes('\n')) {
        const line = input.slice(0, input.indexOf('\n'))
        input = input.slice(input.indexOf('\n') + 1)
        try {
          const packet: unknown = JSON.parse(line)
          if (!object(packet)) throw new Error('Invalid packet')
          if (!authenticated) {
            if (
              packet.op !== 'hello' ||
              !isHarnessId(packet.harness) ||
              typeof packet.token !== 'string' ||
              packet.token.length !== this.token.length ||
              !timingSafeEqual(Buffer.from(packet.token), Buffer.from(this.token))
            )
              throw new Error('Invalid credential')
            harness = packet.harness
            authenticated = true
            socket.setTimeout(90_000)
            this.send(socket, { op: 'ready', enabled: this.enabled(harness) })
          } else if (harness) this.packet(socket, harness, packet)
        } catch {
          socket.destroy()
          return
        }
      }
    })
  }
  private packet(socket: Socket, harness: HarnessId, packet: Record<string, unknown>): void {
    if (packet.op === 'ping') {
      this.send(socket, { op: 'ready', enabled: this.enabled(harness) })
      return
    }
    if (packet.op === 'resolved' && text(packet.id, 256)) {
      for (const [id, p] of this.pending)
        if (p.owner === socket && p.sourceId === packet.id) this.finish(id, 'allow')
      return
    }
    if (packet.op === 'result' && text(packet.id, 256)) {
      const entry = [...this.pending].find(
        ([, p]) => p.owner === socket && p.sourceId === packet.id,
      )
      if (!entry) return
      const [id, p] = entry
      if (!p.response) return
      if (packet.ok === true)
        this.finish(
          id,
          'decision' in p.response ? p.response.decision : 'allow',
          true,
          p.view.harness === 'opencode' &&
            !('decision' in p.response && p.response.decision === 'native')
            ? 'confirmed'
            : 'unavailable',
        )
      else if (packet.uncertain === true) {
        p.view = {
          ...p.view,
          submitting: true,
          error: 'The response could not be confirmed. Check the agent before continuing.',
        }
        this.changed()
      } else {
        this.lifecycle(id, 'rejected')
        p.response = undefined
        p.view = {
          ...p.view,
          submitting: false,
          error:
            'The agent did not accept the response. Refresh its request or answer in the agent.',
        }
        this.changed()
      }
      return
    }
    if (!this.enabled(harness)) {
      this.send(socket, { op: 'disabled' })
      return
    }
    // Codex approvals come from its native runtime. Legacy hooks must return
    // immediately so Codex can display the same request in its own interface.
    if (harness === 'codex') {
      this.send(socket, { op: 'retired', id: packet.id })
      return
    }
    if (
      packet.op !== 'request' ||
      !text(packet.id, 256) ||
      !text(packet.sessionId, 128) ||
      !['permission', 'question'].includes(String(packet.kind))
    )
      return
    // Updating an existing source request never re-enables a submitted answer.
    // A different connection re-sending the same harness request (e.g. two
    // OpenCode plugin hosts observing one form) must not create a second
    // visible prompt. Retire the duplicate sender; ownership stays strict so
    // only the original connection can resolve or answer it.
    const existing = [...this.pending.values()].find(
      (p) => p.owner === socket && p.sourceId === packet.id,
    )
    if (existing) {
      if (!existing.hook && packet.persistent !== true) {
        clearTimeout(existing.timer)
        existing.view = { ...existing.view, expiresAt: Date.now() + 70_000 }
        existing.timer = setTimeout(
          () => this.finish(existing.view.id, 'native', true, 'expired'),
          70_000,
        )
      }
      return
    }
    if (
      [...this.pending.values()].some((p) => p.view.harness === harness && p.sourceId === packet.id)
    ) {
      this.send(socket, { op: 'retired', id: packet.id })
      return
    }
    const retire = () => this.send(socket, { op: 'retired', id: packet.id })
    if (this.pending.size >= 64 || !text(packet.details, 64_000)) {
      retire()
      return
    }
    const questions: AgentQuestion[] = []
    if (packet.kind === 'question') {
      if (
        !Array.isArray(packet.questions) ||
        !packet.questions.length ||
        packet.questions.length > 8
      ) {
        retire()
        return
      }
      for (const q of packet.questions) {
        if (
          !object(q) ||
          !text(q.text, 4096) ||
          !Array.isArray(q.options) ||
          q.options.length > 16 ||
          !q.options.every(
            (o) =>
              object(o) &&
              text(o.label, 256) &&
              typeof o.description === 'string' &&
              o.description.length <= 2048,
          )
        ) {
          retire()
          return
        }
        if (new Set(q.options.map((o) => o.label)).size !== q.options.length) {
          retire()
          return
        }
        questions.push({
          text: q.text,
          header: typeof q.header === 'string' ? q.header.slice(0, 128) : '',
          multiple: q.multiple === true,
          custom: q.custom === true,
          options: q.options as AgentQuestion['options'],
        })
      }
      if (new Set(questions.map((q) => q.text)).size !== questions.length) {
        retire()
        return
      }
    }
    const id = randomUUID()
    const createdAt = Date.now()
    const lifetime =
      packet.hook === true ? HOOK_WINDOW : packet.persistent === true ? 86_400_000 : 70_000
    const expiresAt = createdAt + lifetime
    const view: AgentRequest = {
      id,
      sessionId: `${harness}:${packet.sessionId}`,
      harness,
      kind: packet.kind as AgentRequest['kind'],
      tool: typeof packet.tool === 'string' ? packet.tool.slice(0, 256) : null,
      details: packet.details,
      questions,
      createdAt,
      expiresAt,
      deadlineSource: 'buddy',
      submitting: false,
      error: null,
    }
    const p: Pending = {
      view,
      owner: socket,
      sourceId: packet.id,
      providerId: packet.sessionId,
      turnId: typeof packet.turnId === 'string' ? packet.turnId.slice(0, 128) : null,
      hook: packet.hook === true,
      inputDigest:
        packet.hook === true &&
        typeof packet.inputDigest === 'string' &&
        /^[0-9a-f]{64}$/.test(packet.inputDigest)
          ? packet.inputDigest
          : null,
      toolUseId: null,
      timer: setTimeout(() => {
        this.send(socket, { op: 'reply', id: packet.id, response: { decision: 'native' } })
        this.finish(id, 'native', true, 'expired')
      }, lifetime),
    }
    try {
      this.observed({
        ...this.context(p),
        cwd: typeof packet.cwd === 'string' ? packet.cwd.slice(0, 2048) : null,
      })
    } catch (error) {
      clearTimeout(p.timer)
      throw error
    }
    p.toolUseId = this.claimToolUse(view.sessionId, p.inputDigest)
    this.pending.set(id, p)
    this.changed()
  }
  dispose(): void {
    for (const socket of this.sockets) socket.destroy()
    for (const p of this.pending.values()) clearTimeout(p.timer)
    this.pending.clear()
    this.toolUses.clear()
    this.server.close()
    try {
      unlinkSync(this.socketPath)
      rmdirSync(dirname(this.socketPath))
    } catch {
      /* Already stopped. */
    }
  }
}
