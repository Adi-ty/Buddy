import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'
import { isObject, isRpcId, type RpcId } from './codex-request'

export function codexSocketPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(
    resolve(env.CODEX_HOME || join(home, '.codex')),
    'app-server-control',
    'app-server-control.sock',
  )
}

// Codex uses WebSocket messages over its user-owned Unix control socket.
// No daemon is launched, no TCP ports are guessed, and no auth file is read.
export class CodexRpcClient {
  private readonly socket: WebSocket
  private readonly prefix = `buddy-${randomUUID()}`
  private next = 0
  private stopped = false
  private readonly pending = new Map<
    RpcId,
    {
      resolve: (value: Record<string, unknown>) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  constructor(
    path: string,
    private readonly receive: (message: Record<string, unknown>) => void,
    private readonly disconnected: () => void,
  ) {
    // Codex links its control path to a short daemon socket. Resolving that
    // link also supports CODEX_HOME paths beyond Unix socket address limits.
    const endpoint = realpathSync(path)
    const stat = statSync(endpoint)
    if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
      throw new Error('Codex control socket must belong to the current user and be private.')
    this.socket = new WebSocket('ws://localhost/', {
      createConnection: () => connect({ path: endpoint }),
      handshakeTimeout: 5000,
      maxPayload: 1024 * 1024,
      perMessageDeflate: false,
      followRedirects: false,
    })
    this.socket.on('error', () => this.stop())
    this.socket.on('close', () => this.stop())
    this.socket.on('message', (data, binary) => {
      if (binary) return this.stop()
      try {
        const message: unknown = JSON.parse(data.toString())
        if (!isObject(message)) return this.stop()
        if (typeof message.method === 'string') this.receive(message)
        else if (isRpcId(message.id)) {
          const request = this.pending.get(message.id)
          if (!request) return
          this.pending.delete(message.id)
          clearTimeout(request.timer)
          if (isObject(message.error))
            request.reject(new Error('Codex rejected the protocol request.'))
          else if (isObject(message.result)) request.resolve(message.result)
          else request.reject(new Error('Invalid Codex response.'))
        }
      } catch {
        this.stop()
      }
    })
  }
  async open(): Promise<void> {
    if (this.stopped) throw new Error('Codex is disconnected.')
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', resolve)
      this.socket.once('error', () => reject(new Error('Codex is unavailable.')))
      this.socket.once('close', () => reject(new Error('Codex is unavailable.')))
    })
    await this.call('initialize', {
      clientInfo: { name: 'buddy', title: 'Buddy', version: '0.1.0' },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [
          'item/agentMessage/delta',
          'item/plan/delta',
          'item/reasoning/textDelta',
          'item/reasoning/summaryTextDelta',
          'item/reasoning/summaryPartAdded',
          'item/commandExecution/outputDelta',
          'item/commandExecution/terminalInteraction',
          'item/fileChange/outputDelta',
          'item/fileChange/patchUpdated',
          'command/exec/outputDelta',
          'process/outputDelta',
          'turn/diff/updated',
          'turn/plan/updated',
          'thread/tokenUsage/updated',
          'thread/realtime/item/transcript/delta',
          'thread/realtime/transcript/delta',
          'thread/realtime/transcript/done',
          'thread/realtime/outputAudio/delta',
        ],
      },
    })
    this.send({ method: 'initialized' })
  }
  get connected(): boolean {
    return !this.stopped && this.socket.readyState === WebSocket.OPEN
  }
  private send(message: unknown): void {
    if (!this.connected || this.socket.bufferedAmount > 256_000)
      throw new Error('Codex is disconnected or busy.')
    this.socket.send(JSON.stringify(message))
  }
  call(method: string, params: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = `${this.prefix}-${this.next++}`
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Codex did not confirm the protocol request.'))
      }, 8000)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send({ id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }
  respond(id: RpcId, result: unknown): void {
    this.send({ id, result })
  }
  close(): void {
    this.stop()
  }
  private stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.socket.terminate()
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('Codex disconnected.'))
    }
    this.pending.clear()
    this.disconnected()
  }
}
