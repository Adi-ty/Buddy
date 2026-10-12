import { readFileSync } from 'node:fs'
import { connect } from 'node:net'

export function connectControls(path, harness, onMessage, onDisconnect = () => {}) {
  let socket
  let input = ''
  let ready = false
  const send = (packet) => {
    if (socket && !socket.destroyed && ready && socket.writableLength < 256_000)
      socket.write(JSON.stringify(packet) + '\n')
  }
  try {
    const config = JSON.parse(readFileSync(path, 'utf8'))
    socket = connect(config.socket)
    socket.setEncoding('utf8')
    socket.setTimeout(90_000, () => socket.destroy())
    socket.on('error', () => socket.destroy())
    socket.once('connect', () =>
      socket.write(JSON.stringify({ op: 'hello', harness, token: config.token }) + '\n'),
    )
    socket.on('data', (chunk) => {
      input += chunk
      if (Buffer.byteLength(input) > 128_000) return socket.destroy()
      while (input.includes('\n')) {
        const line = input.slice(0, input.indexOf('\n'))
        input = input.slice(input.indexOf('\n') + 1)
        try {
          const message = JSON.parse(line)
          if (message.op === 'ready') ready = true
          onMessage(message)
        } catch {
          socket.destroy()
          return
        }
      }
    })
    socket.once('close', onDisconnect)
  } catch {
    queueMicrotask(onDisconnect)
  }
  return { send, close: () => socket?.destroy() }
}
