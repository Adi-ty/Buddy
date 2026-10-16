import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TELEGRAM_DEFAULTS, type TelegramPreferences } from '../../shared/telegram'
import { integer, record } from './client'

export interface Pair {
  chat: number
  user: number
  label: string
}
export interface MessageMapping {
  chat: number
  message: number
  at: number
}
export interface TelegramData {
  pair: Pair | null
  offset: number
  lastUpdateAt?: number
  preferences: TelegramPreferences
  messages: MessageMapping[]
}
export interface CredentialCipher {
  available(): Promise<boolean>
  encrypt(value: string): Promise<Buffer>
  decrypt(value: Buffer): Promise<string>
}
export interface TelegramPersistence {
  load(): TelegramData
  save(data: TelegramData): void
  token(): Promise<string | null>
  storeToken(token: string, valid?: () => boolean): Promise<void>
  clear(): void
}
export class TelegramStorage implements TelegramPersistence {
  constructor(
    private readonly profile: string,
    private readonly cipher: CredentialCipher,
  ) {}
  private write(name: string, value: string | Buffer): void {
    const path = join(this.profile, name)
    writeFileSync(`${path}.tmp`, value, { mode: 0o600 })
    chmodSync(`${path}.tmp`, 0o600)
    renameSync(`${path}.tmp`, path)
  }
  load(): TelegramData {
    const fresh = { pair: null, offset: 0, preferences: { ...TELEGRAM_DEFAULTS }, messages: [] }
    try {
      const raw: unknown = JSON.parse(readFileSync(join(this.profile, 'telegram.json'), 'utf8'))
      if (!record(raw)) return fresh
      const preferences = { ...TELEGRAM_DEFAULTS }
      for (const key of Object.keys(preferences) as (keyof TelegramPreferences)[])
        if (record(raw.preferences) && typeof raw.preferences[key] === 'boolean')
          preferences[key] = raw.preferences[key]
      const pair =
        record(raw.pair) &&
        integer(raw.pair.chat) &&
        raw.pair.chat > 0 &&
        integer(raw.pair.user) &&
        raw.pair.user > 0 &&
        typeof raw.pair.label === 'string'
          ? { chat: raw.pair.chat, user: raw.pair.user, label: raw.pair.label.slice(0, 128) }
          : null
      const messages = Array.isArray(raw.messages)
        ? raw.messages
            .filter(
              (m): m is MessageMapping =>
                record(m) &&
                integer(m.chat) &&
                integer(m.message) &&
                typeof m.at === 'number' &&
                m.at > Date.now() - 7 * 86_400_000,
            )
            .slice(-256)
        : []
      return {
        pair,
        // Telegram may choose a new random update ID after a week without
        // updates. Its retained updates last only 24 hours; no older offset
        // should prevent reception after that reset.
        offset:
          integer(raw.offset) &&
          raw.offset >= 0 &&
          !(typeof raw.lastUpdateAt === 'number' && Date.now() - raw.lastUpdateAt > 7 * 86_400_000)
            ? raw.offset
            : 0,
        ...(typeof raw.lastUpdateAt === 'number' ? { lastUpdateAt: raw.lastUpdateAt } : {}),
        preferences,
        messages,
      }
    } catch {
      return fresh
    }
  }
  save(data: TelegramData): void {
    this.write('telegram.json', JSON.stringify({ ...data, messages: data.messages.slice(-256) }))
  }
  async token(): Promise<string | null> {
    const path = join(this.profile, 'telegram-token.enc')
    if (!existsSync(path)) return null
    if (!(await this.cipher.available()))
      throw new Error('Secure credential storage is unavailable.')
    try {
      return await this.cipher.decrypt(readFileSync(path))
    } catch {
      throw new Error('Could not unlock the Telegram credential. Disconnect and enter it again.')
    }
  }
  async storeToken(token: string, valid: () => boolean = () => true): Promise<void> {
    if (!(await this.cipher.available()))
      throw new Error('Secure credential storage is unavailable.')
    let encrypted: Buffer
    try {
      encrypted = await this.cipher.encrypt(token)
    } catch {
      throw new Error('Could not secure the Telegram credential.')
    }
    if (valid()) this.write('telegram-token.enc', encrypted)
  }
  clear(): void {
    // Revoke persisted identity before removing the encrypted token.
    let failed = false
    try {
      this.save({ pair: null, offset: 0, preferences: { ...TELEGRAM_DEFAULTS }, messages: [] })
    } catch {
      failed = true
    }
    for (const name of ['telegram-token.enc', 'telegram-token.enc.tmp']) {
      try {
        unlinkSync(join(this.profile, name))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failed = true
      }
    }
    if (failed)
      throw new Error(
        'Could not completely remove Telegram settings. Check the profile directory before restarting Buddy.',
      )
  }
}
