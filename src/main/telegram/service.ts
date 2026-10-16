import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { SessionRecord } from '../../shared/contracts'
import {
  TELEGRAM_DEFAULTS,
  type TelegramPairing,
  type TelegramPreferences,
  type TelegramStatus,
} from '../../shared/telegram'
import type { RequestService } from '../request-service'
import {
  integer,
  record,
  TelegramClient,
  TelegramError,
  TelegramCancelled,
  type TelegramTransport,
} from './client'
import { turnMessage } from './messages'
import { TelegramRequests } from './requests'
import { TelegramStatusView } from './status'
import type { TelegramData, TelegramPersistence } from './storage'

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Stopped'))
      return
    }
    const abort = () => {
      clearTimeout(timer)
      reject(new Error('Stopped'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

export class TelegramService {
  private data: TelegramData
  private state: TelegramStatus['state'] = 'disconnected'
  private message = 'Connect your own bot to receive notifications and answer supported requests.'
  private username: string | null = null
  private botId = 0
  private client: TelegramTransport | null = null
  private controller = new AbortController()
  private generation = 0
  private challenge: { value: string; expiresAt: number } | null = null
  private requests: TelegramRequests | null = null
  private navigation: TelegramStatusView | null = null
  private sessions: readonly SessionRecord[] = []
  private queue: Promise<unknown> = Promise.resolve()
  private queued = 0
  private nextSend = 0
  private busy = false
  private tick: ReturnType<typeof setInterval> | null = null
  private deliveryProblem = false
  private readonly failedCleanups = new Set<number>()
  private cleaning = false
  constructor(
    private readonly options: {
      storage: TelegramPersistence
      requests: RequestService
      changed: () => void
      client?: (token: string) => TelegramTransport
      sendInterval?: number
      trackingAvailable?: () => boolean
    },
  ) {
    this.data = options.storage.load()
  }
  status(): TelegramStatus {
    return {
      state: this.state,
      message: this.message,
      botUsername: this.username,
      pairedUser: this.data.pair?.label ?? null,
      deliveryProblem: this.hasDeliveryProblem(),
      preferences: { ...this.data.preferences },
    }
  }
  private setState(state: TelegramStatus['state'], message: string): void {
    if (state === this.state && message === this.message) return
    this.state = state
    this.message = message
    this.options.changed()
  }
  private hasDeliveryProblem(): boolean {
    return (
      this.deliveryProblem || this.failedCleanups.size > 0 || !!this.requests?.hasDeliveryProblem()
    )
  }
  private deliveryResult(failed: boolean, generation: number): void {
    if (generation !== this.generation) return
    this.deliveryProblem = failed
    if (this.state === 'connected') this.ready()
  }
  private save(): void {
    try {
      this.options.storage.save(this.data)
    } catch {
      this.stop()
      this.setState('error', 'Telegram storage is unavailable. Disconnect before reconnecting.')
      throw new Error('Telegram storage is unavailable.')
    }
  }
  async start(): Promise<void> {
    const generation = this.generation
    try {
      const token = await this.options.storage.token()
      if (generation !== this.generation || !token) return
      await this.connect(token, false)
    } catch {
      if (generation === this.generation)
        this.setState(
          'error',
          'Could not restore Telegram. Disconnect and enter your token again locally.',
        )
    }
  }
  async connect(token: unknown, replace = true): Promise<TelegramPairing | null> {
    if (this.busy) throw new Error('Telegram setup is already in progress.')
    if (typeof token !== 'string' || token.length > 160) throw new Error('Enter a valid bot token.')
    if (replace && this.client)
      throw new Error('Disconnect the current bot before replacing its token.')
    this.busy = true
    this.stop()
    this.deliveryProblem = false
    this.failedCleanups.clear()
    const generation = this.generation
    const signal = this.controller.signal
    this.setState('validating', 'Validating the bot and secure credential storage…')
    try {
      const client = this.options.client?.(token) ?? new TelegramClient(token)
      const me = await client.call('getMe', {}, signal)
      if (generation !== this.generation) return null
      if (
        !record(me) ||
        !integer(me.id) ||
        me.is_bot !== true ||
        typeof me.username !== 'string' ||
        !/^[a-zA-Z0-9_]{5,32}$/.test(me.username)
      )
        throw new Error('Telegram did not return a valid bot identity.')
      const webhook = await client.call('getWebhookInfo', {}, signal)
      if (generation !== this.generation) return null
      if (!record(webhook) || typeof webhook.url !== 'string')
        throw new Error('Could not verify the bot connection.')
      if (webhook.url) throw new TelegramError(409)
      if (replace) {
        this.options.storage.clear()
        this.data = { pair: null, offset: 0, preferences: { ...TELEGRAM_DEFAULTS }, messages: [] }
        await this.options.storage.storeToken(token, () => generation === this.generation)
        if (generation !== this.generation) return null
        this.save()
      }
      this.client = client
      this.botId = me.id
      this.username = me.username
      const pairing = this.data.pair ? null : this.newChallenge()
      this.begin()
      return pairing
    } catch (error) {
      if (generation !== this.generation) return null
      this.setState(
        error instanceof TelegramError && error.code === 409 ? 'conflict' : 'error',
        error instanceof TelegramError
          ? error.message
          : 'Could not connect securely. Check the token and OS credential storage, then try again.',
      )
      throw new Error(this.message)
    } finally {
      this.busy = false
    }
  }
  pairing(): TelegramPairing {
    if (!this.client || this.data.pair || this.state === 'disconnected')
      throw new Error('Connect an unpaired bot first.')
    const result = this.newChallenge()
    this.options.changed()
    return result
  }
  pairingLink(value: unknown): string {
    if (
      this.state !== 'pairing' ||
      !this.challenge ||
      this.data.pair ||
      Date.now() >= this.challenge.expiresAt
    )
      throw new Error('Pairing link is no longer available. Generate a new one.')
    const url = `https://t.me/${this.username}?start=${this.challenge.value}`
    if (value !== url) throw new Error('Pairing link is no longer available. Generate a new one.')
    return url
  }
  private newChallenge(): TelegramPairing {
    this.challenge = {
      value: randomBytes(24).toString('base64url'),
      expiresAt: Date.now() + 300_000,
    }
    return {
      url: `https://t.me/${this.username}?start=${this.challenge.value}`,
      expiresAt: this.challenge.expiresAt,
    }
  }
  private ready(): void {
    this.setState(
      this.data.pair ? 'connected' : 'pairing',
      this.data.pair
        ? this.hasDeliveryProblem()
          ? 'Connected. Some messages could not be updated or delivered. Check pending requests in Buddy.'
          : 'Connected. Buddy must stay running, awake and connected to your agent.'
        : this.challenge
          ? 'Open the pairing link on your phone and tap Start within five minutes.'
          : 'Pairing expired. Generate a new link in Buddy.',
    )
  }
  private begin(): void {
    if (!this.client) return
    this.ready()
    this.installRequests()
    this.tick = setInterval(() => {
      if (this.challenge && Date.now() >= this.challenge.expiresAt) {
        this.challenge = null
        this.ready()
      }
      this.reconcile(this.sessions)
    }, 1000)
    this.tick.unref?.()
    void this.poll(this.generation)
  }
  private installRequests(): void {
    if (!this.data.pair || this.requests) return
    const installedGeneration = this.generation
    this.navigation = new TelegramStatusView({
      chat: this.data.pair.chat,
      botId: this.botId,
      snapshot: () => ({
        sessions: this.sessions,
        available: this.options.trackingAvailable?.() ?? true,
        paused: this.data.preferences.paused,
      }),
      send: (method, body, valid) => this.send(method, body, valid),
    })
    // The command menu is scoped to the paired private chat. It carries no
    // session data, and failures must not prevent requests or polling.
    void this.client
      ?.call(
        'setMyCommands',
        {
          scope: { type: 'chat', chat_id: this.data.pair.chat },
          commands: [
            { command: 'status', description: 'View your sessions' },
            { command: 'help', description: 'Show commands' },
          ],
        },
        this.controller.signal,
      )
      .catch(() => {})
    this.requests = new TelegramRequests({
      requests: this.options.requests,
      pair: this.data.pair,
      botId: this.botId,
      send: (method, body, valid) => this.send(method, body, valid),
      remember: (mapping) => {
        if (installedGeneration !== this.generation) return
        this.data.messages.push(mapping)
        this.data.messages = this.data.messages.slice(-256)
        for (const message of this.failedCleanups)
          if (!this.data.messages.some((m) => m.message === message))
            this.failedCleanups.delete(message)
        this.save()
      },
      forget: (message) => {
        if (installedGeneration !== this.generation) return
        this.data.messages = this.data.messages.filter((m) => m.message !== message)
        this.save()
      },
      error: () => this.deliveryResult(true, installedGeneration),
      changed: () => {
        if (installedGeneration === this.generation && this.state === 'connected') this.ready()
      },
    })
    // Persisted IDs only remove old keyboards. They never restore answer state.
    void this.cleanupMappings()
    this.reconcile(this.sessions)
  }
  private async cleanupMappings(): Promise<void> {
    if (this.cleaning) return
    this.cleaning = true
    const generation = this.generation
    try {
      for (const mapping of [...this.data.messages]) {
        if (generation !== this.generation) return
        if (this.requests?.hasMessage(mapping.message)) continue
        try {
          // Enqueue one at a time so historical cleanup cannot starve a new
          // live permission behind hundreds of old message IDs.
          await this.send('editMessageReplyMarkup', {
            chat_id: mapping.chat,
            message_id: mapping.message,
            reply_markup: { inline_keyboard: [] },
          })
          if (generation !== this.generation) return
          this.data.messages = this.data.messages.filter((m) => m !== mapping)
          this.save()
          this.failedCleanups.delete(mapping.message)
          this.deliveryResult(false, generation)
        } catch {
          if (generation !== this.generation) return
          this.failedCleanups.add(mapping.message)
          this.deliveryResult(true, generation)
        }
      }
    } finally {
      if (generation === this.generation) this.cleaning = false
    }
  }
  private async poll(generation: number): Promise<void> {
    let failures = 0
    const client = this.client!
    const signal = this.controller.signal
    while (generation === this.generation && !signal.aborted) {
      try {
        const updates = await client.call(
          'getUpdates',
          {
            offset: this.data.offset,
            timeout: 30,
            limit: 100,
            allowed_updates: ['message', 'callback_query'],
          },
          signal,
        )
        if (generation !== this.generation) return
        if (!Array.isArray(updates) || updates.length > 100) throw new TelegramError(0)
        if (failures || this.hasDeliveryProblem()) {
          // Polling proves inbound connectivity, not message delivery. Only
          // retry safe edits; their results determine whether the warning clears.
          this.requests?.recoverEdits()
          void this.cleanupMappings()
        }
        failures = 0
        this.ready()
        for (const update of updates) {
          if (generation !== this.generation) return
          if (!record(update) || !integer(update.update_id) || update.update_id < this.data.offset)
            continue
          // Commit offset before effects. Crash recovery may lose an operation,
          // but must never replay an agent answer. The native UI stays available.
          this.data.offset = update.update_id + 1
          this.data.lastUpdateAt = Date.now()
          this.save()
          await this.update(update, generation)
        }
        if (!updates.length) await pause(100, signal)
      } catch (error) {
        if (generation !== this.generation || signal.aborted) return
        const fault = error instanceof TelegramError ? error : new TelegramError(0)
        if ([401, 403, 409].includes(fault.code)) {
          this.stop()
          this.setState(fault.code === 409 ? 'conflict' : 'error', fault.message)
          return
        }
        this.setState('offline', fault.message)
        try {
          await pause(
            Math.max(
              fault.retryAfter * 1000,
              Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)),
            ),
            signal,
          )
        } catch {
          return
        }
      }
    }
  }
  private async update(update: Record<string, unknown>, generation: number): Promise<void> {
    const callback = update.callback_query
    if (record(callback)) {
      const pair = this.data.pair
      const authorized =
        pair &&
        record(callback.from) &&
        callback.from.id === pair.user &&
        callback.from.is_bot !== true
      const navigation = typeof callback.data === 'string' && callback.data.startsWith('st:')
      const notice =
        authorized && navigation
          ? (this.navigation?.callback(callback.data as string, callback.message) ??
            (!this.navigation ? 'Send /status for a new view.' : undefined))
          : undefined
      // Acknowledgment is neutral, and never waits behind message rate limits.
      if (typeof callback.id === 'string' && callback.id.length <= 256)
        void this.client
          ?.call(
            'answerCallbackQuery',
            {
              callback_query_id: callback.id,
              ...(notice ? { text: notice } : {}),
            },
            this.controller.signal,
          )
          .catch(() => {})
      if (!authorized || navigation) return
      void this.requests?.callback(callback.data, callback.message).catch(() => {
        this.deliveryResult(true, generation)
      })
      return
    }
    const message = update.message
    if (
      !record(message) ||
      !record(message.chat) ||
      message.chat.type !== 'private' ||
      !integer(message.chat.id) ||
      !record(message.from) ||
      !integer(message.from.id) ||
      message.from.is_bot === true
    )
      return
    if (!this.data.pair) {
      if (
        !this.challenge ||
        Date.now() >= this.challenge.expiresAt ||
        typeof message.text !== 'string'
      )
        return
      const match = /^\/start(?:@[a-zA-Z0-9_]+)? ([A-Za-z0-9_-]+)$/.exec(message.text)
      if (
        !match ||
        match[1]!.length !== this.challenge.value.length ||
        !timingSafeEqual(Buffer.from(match[1]!), Buffer.from(this.challenge.value))
      )
        return
      this.challenge = null
      const label = `${typeof message.from.first_name === 'string' ? message.from.first_name.slice(0, 64) : 'Telegram user'} (${message.from.id})`
      this.data.pair = { chat: message.chat.id, user: message.from.id, label }
      this.save()
      this.ready()
      this.installRequests()
      this.navigation?.open('welcome')
      return
    }
    if (
      generation !== this.generation ||
      message.chat.id !== this.data.pair.chat ||
      message.from.id !== this.data.pair.user
    )
      return
    // Replies belong to their question prompt, even if the answer is "/status".
    if (message.reply_to_message) {
      this.requests?.reply(message)
      return
    }
    if (typeof message.text !== 'string') return
    const command = /^\/(status|help|start)(?:@([a-zA-Z0-9_]+))?\s*$/i.exec(message.text)
    if (!command || (command[2] && command[2].toLowerCase() !== this.username?.toLowerCase()))
      return
    this.navigation?.open(command[1]!.toLowerCase() === 'status' ? 'status' : 'help')
  }
  private send(
    method: string,
    body: Record<string, unknown>,
    valid: () => boolean = () => true,
  ): Promise<unknown> {
    const generation = this.generation
    if (this.queued >= 256) {
      this.deliveryResult(true, generation)
      return Promise.reject(new Error('Telegram queue is full.'))
    }
    const signal = this.controller.signal
    const client = this.client
    ++this.queued
    const work = this.queue
      .catch(() => {})
      .then(async () => {
        if (!client || generation !== this.generation || signal.aborted || !valid())
          throw new TelegramCancelled('Stopped before dispatch')
        await pause(Math.max(0, this.nextSend - Date.now()), signal)
        if (generation !== this.generation || !valid())
          throw new TelegramCancelled('Stopped before dispatch')
        this.nextSend = Date.now() + (this.options.sendInterval ?? 1100)
        try {
          return await client.call(method, body, signal)
        } catch (error) {
          if (
            generation === this.generation &&
            error instanceof TelegramError &&
            [401, 403].includes(error.code)
          ) {
            this.stop()
            this.setState('error', error.message)
          }
          // Only an explicit rate-limit rejection is safe to retry for sends.
          if (!(error instanceof TelegramError) || error.code !== 429) throw error
          this.nextSend = Date.now() + Math.max(1000, error.retryAfter * 1000)
          await pause(Math.max(0, this.nextSend - Date.now()), signal)
          if (generation !== this.generation || !valid())
            throw new TelegramCancelled('Stopped before dispatch')
          this.nextSend = Date.now() + (this.options.sendInterval ?? 1100)
          return client.call(method, body, signal)
        }
      })
      .then(
        (result) => {
          this.deliveryResult(false, generation)
          return result
        },
        (error: unknown) => {
          if (!(error instanceof TelegramCancelled)) this.deliveryResult(true, generation)
          throw error
        },
      )
      .finally(() => {
        --this.queued
      })
    this.queue = work
    return work
  }
  reconcile(sessions: readonly SessionRecord[]): void {
    this.sessions = sessions
    this.requests?.reconcile(sessions, this.data.preferences)
  }
  observe(
    before: SessionRecord | null | undefined,
    current: SessionRecord | null | undefined,
  ): void {
    if (
      !this.data.pair ||
      !this.client ||
      !this.requests ||
      this.data.preferences.paused ||
      !before ||
      !current ||
      current.presence !== 'observed'
    )
      return
    const completed = current.status === 'completed' && this.data.preferences.completions
    const failed =
      current.status === 'error' && current.turnActive === false && this.data.preferences.failures
    if (
      (!completed && !failed) ||
      (before.status === current.status &&
        before.turnId === current.turnId &&
        before.turnActive === current.turnActive)
    )
      return
    void this.send('sendMessage', {
      chat_id: this.data.pair.chat,
      text: turnMessage(current, this.sessions),
    }).catch(() => {}) // send() records delivery results for its own generation.
  }
  preferences(value: unknown): void {
    if (
      !record(value) ||
      Object.keys(value).length !== Object.keys(TELEGRAM_DEFAULTS).length ||
      !Object.keys(TELEGRAM_DEFAULTS).every((key) => typeof value[key] === 'boolean')
    )
      throw new Error('Invalid Telegram notification settings.')
    this.data.preferences = { ...value } as unknown as TelegramPreferences
    this.save()
    this.options.changed()
    this.reconcile(this.sessions)
  }
  suspend(): void {
    this.stop()
    if (this.client) this.setState('suspended', 'Telegram is suspended while the computer sleeps.')
  }
  resume(): void {
    if (!this.client || !['suspended', 'offline', 'conflict', 'error'].includes(this.state)) return
    this.stop()
    this.begin()
  }
  async reconnect(): Promise<void> {
    if (this.client) this.resume()
    else await this.start()
  }
  disconnect(): void {
    this.stop() // Synchronously revoke all local authority before disk work.
    this.deliveryProblem = false
    this.failedCleanups.clear()
    this.client = null
    this.username = null
    this.botId = 0
    this.data.pair = null
    this.data.messages = []
    this.data.offset = 0
    this.setState(
      'disconnected',
      'Disconnected and unpaired. Existing Telegram history is retained; old buttons cannot answer requests.',
    )
    this.options.storage.clear()
  }
  private stop(): void {
    ++this.generation
    this.controller.abort()
    this.controller = new AbortController()
    this.requests?.dispose()
    this.requests = null
    this.navigation?.dispose()
    this.navigation = null
    this.challenge = null
    if (this.tick) clearInterval(this.tick)
    this.tick = null
    this.queue = Promise.resolve()
    this.nextSend = 0
    this.cleaning = false
  }
  dispose(): void {
    this.stop()
    this.client = null
  }
}
