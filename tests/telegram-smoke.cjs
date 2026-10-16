// A fake Bot API and fake credential cipher scoped to the Electron smoke
// process. No network, real bot token, or OS Keychain access is needed.
module.exports = function installTelegramFixture(safeStorage) {
  const messages = new Map()
  const updates = []
  let poll = null
  let nextMessage = 1
  let nextUpdate = 1
  const token = '123456789:smoke_fixture_not_a_real_bot_token'
  safeStorage.isAsyncEncryptionAvailable = async () => true
  safeStorage.encryptStringAsync = async () => Buffer.from('smoke-encrypted-credential')
  safeStorage.decryptStringAsync = async () => ({ result: token, shouldReEncrypt: false })
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith('https://api.telegram.org/')) return realFetch(url, options)
    const method = String(url).split('/').at(-1)
    const body = JSON.parse(options.body)
    let result
    if (method === 'getMe') result = { id: 123, is_bot: true, username: 'buddy_smoke_bot' }
    else if (method === 'getWebhookInfo') result = { url: '' }
    else if (method === 'getUpdates') {
      result = updates.length
        ? updates.splice(0)
        : await new Promise((resolve, reject) => {
            const abort = () => {
              poll = null
              reject(new Error('Fixture poll aborted'))
            }
            options.signal.addEventListener('abort', abort, { once: true })
            poll = (batch) => {
              options.signal.removeEventListener('abort', abort)
              poll = null
              resolve(batch)
            }
            if (options.signal.aborted) abort()
          })
    } else if (method === 'sendMessage') {
      result = {
        ...body,
        message_id: nextMessage++,
        from: { id: 123 },
        chat: { id: body.chat_id, type: 'private' },
      }
      messages.set(result.message_id, result)
    } else if (method.startsWith('editMessage')) {
      result = { ...messages.get(body.message_id), ...body }
      messages.set(body.message_id, result)
    } else result = true
    return new Response(JSON.stringify({ ok: true, result }))
  }
  const push = (update) => {
    const value = { update_id: nextUpdate++, ...update }
    if (poll) poll([value])
    else updates.push(value)
  }
  return {
    token,
    messages,
    command: (text) =>
      push({
        message: {
          message_id: 900 + nextUpdate,
          from: { id: 456 },
          chat: { id: 456, type: 'private' },
          text,
        },
      }),
    pair: (url) =>
      push({
        message: {
          message_id: 1,
          from: { id: 456, first_name: 'Smoke' },
          chat: { id: 456, type: 'private' },
          text: '/start ' + new URL(url).searchParams.get('start'),
        },
      }),
    tap: (message, data) =>
      push({ callback_query: { id: 'smoke-' + nextUpdate, from: { id: 456 }, message, data } }),
  }
}
