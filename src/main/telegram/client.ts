export class TelegramCancelled extends Error {}
export class TelegramError extends Error {
  constructor(
    readonly code: number,
    readonly retryAfter = 0,
  ) {
    super(
      code === 401
        ? 'Telegram rejected the bot token. Disconnect and enter the new token from BotFather.'
        : code === 409
          ? 'Another poller or webhook is using this bot. Stop it, then reconnect.'
          : code === 429
            ? 'Telegram rate limited this bot. Waiting before continuing.'
            : code === 403
              ? 'Telegram access was denied. Open the bot chat and unblock it.'
              : 'Telegram could not confirm the operation. Check your connection.',
    )
  }
}
export interface TelegramTransport {
  call(method: string, data: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
}
export const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
export const integer = (value: unknown): value is number => Number.isSafeInteger(value)

// No raw fetch/Telegram errors escape this boundary: their URLs can contain
// the bot credential. Plain text messages avoid provider-controlled markup.
export class TelegramClient implements TelegramTransport {
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/.test(token))
      throw new Error('Enter the complete bot token from BotFather.')
  }
  async call(method: string, data: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (
      ![
        'getMe',
        'getWebhookInfo',
        'getUpdates',
        'setMyCommands',
        'sendMessage',
        'editMessageText',
        'editMessageReplyMarkup',
        'answerCallbackQuery',
      ].includes(method)
    )
      throw new Error('Unsupported Telegram operation.')
    try {
      const response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(method === 'getUpdates' ? 40_000 : 15_000),
        ]),
        redirect: 'error',
      })
      const body: unknown = await response.json()
      if (!record(body) || body.ok !== true) {
        const code = record(body) && integer(body.error_code) ? body.error_code : response.status
        const retry =
          record(body) && record(body.parameters) && integer(body.parameters.retry_after)
            ? Math.max(0, Math.min(86_400, body.parameters.retry_after))
            : 0
        throw new TelegramError(code, retry)
      }
      return body.result
    } catch (error) {
      if (error instanceof TelegramError) throw error
      throw new TelegramError(0)
    }
  }
}
