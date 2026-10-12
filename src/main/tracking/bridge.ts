import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { socketDirectory } from './socket-directory'
import { normalizeObservation, type Observation } from './events'

export class ObservationBridge {
  private readonly token = randomBytes(32).toString('hex')
  private readonly server: Server
  private readonly sockets = new Set<Socket>()
  private readonly directory: string
  private readonly socketPath: string
  constructor(
    private readonly profile: string,
    private readonly onObservation: (event: Observation) => void,
  ) {
    this.directory = socketDirectory(profile)
    this.socketPath = join(this.directory, 'events.sock')
    this.server = createServer({ allowHalfOpen: true }, (socket) => {
      if (this.sockets.size >= 32) {
        socket.destroy()
        return
      }
      this.sockets.add(socket)
      socket.setTimeout(250, () => socket.destroy())
      socket.once('close', () => this.sockets.delete(socket))
      socket.on('error', () => socket.destroy())
      let input = ''
      let handled = false
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => {
        input += chunk
        if (Buffer.byteLength(input) > 16_384) {
          socket.destroy()
          return
        }
        if (handled || !input.includes('\n')) return
        handled = true
        try {
          const packet = JSON.parse(input.slice(0, input.indexOf('\n'))) as {
            token: unknown
            observation: unknown
          }
          if (
            typeof packet.token !== 'string' ||
            packet.token.length !== this.token.length ||
            !timingSafeEqual(Buffer.from(packet.token), Buffer.from(this.token))
          )
            throw new Error('Invalid credential')
          const event = normalizeObservation(packet.observation)
          if (!event) throw new Error('Invalid observation')
          this.onObservation(event)
          socket.end('ok\n')
        } catch {
          socket.end('ignored\n')
        }
      })
    })
  }
  async start(): Promise<void> {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const stat = lstatSync(this.directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
      throw new Error('Unsafe bridge directory')
    chmodSync(this.directory, 0o700)
    if (existsSync(this.socketPath)) {
      if (!lstatSync(this.socketPath).isSocket())
        throw new Error('Unexpected file at bridge socket')
      unlinkSync(this.socketPath)
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.socketPath, () => {
        this.server.removeListener('error', reject)
        resolve()
      })
    })
    this.server.on('error', (error) => console.error('Observation bridge error', error))
    chmodSync(this.socketPath, 0o600)
    const path = join(this.profile, 'bridge.json')
    writeFileSync(
      `${path}.tmp`,
      JSON.stringify({ version: 1, token: this.token, socket: this.socketPath }),
      { mode: 0o600 },
    )
    chmodSync(`${path}.tmp`, 0o600)
    renameSync(`${path}.tmp`, path)
  }
  dispose(): void {
    for (const socket of this.sockets) socket.destroy()
    this.server.close()
    try {
      unlinkSync(this.socketPath)
      rmdirSync(this.directory)
    } catch {
      /* Already gone. */
    }
  }
}
