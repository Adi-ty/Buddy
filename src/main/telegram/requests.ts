import { randomBytes } from 'node:crypto'
import type { AgentRequest, AgentResponse, SessionRecord } from '../../shared/contracts'
import type { TelegramPreferences } from '../../shared/telegram'
import { RequestService, type RequestResolution } from '../request-service'
import { validateResponse } from '../tracking/request-response'
import { integer, record, TelegramCancelled } from './client'
import { sessionContext } from './messages'
import type { MessageMapping, Pair } from './storage'

export type Send = (
  method: string,
  data: Record<string, unknown>,
  valid?: () => boolean,
) => Promise<unknown>
type Action =
  | { decision: 'allow' | 'reject' }
  | { question: number }
  | { option: number }
  | { custom: true }
  | { submit: true }
interface Entry {
  request: AgentRequest
  title: string
  message?: number
  answers: string[][]
  question: number
  revision: number
  rendering: boolean
  dirty: boolean
  label: string | null
  sendUnconfirmed: boolean
  editFailed: boolean
  handles: string[]
}

// Drafts and opaque button/reply handles are memory-only. Every operation
// rechecks the live bridge; a Telegram message is never an authority source.
export class TelegramRequests {
  private readonly entries = new Map<string, Entry>()
  private readonly handles = new Map<string, { entry: Entry; action: Action; revision: number }>()
  private readonly prompts = new Map<number, { entry: Entry; question: number }>()
  private readonly unsubscribe: () => void
  private stopped = false
  constructor(
    private readonly options: {
      requests: RequestService
      pair: Pair
      botId: number
      send: Send
      remember: (mapping: MessageMapping) => void
      forget: (message: number) => void
      error: () => void
      changed: () => void
    },
  ) {
    this.unsubscribe = options.requests.subscribe((resolution) => this.resolved(resolution))
  }
  private invalidate(entry: Entry): void {
    for (const handle of entry.handles) this.handles.delete(handle)
    entry.handles = []
    ++entry.revision
  }
  private live(entry: Entry): AgentRequest | undefined {
    if (this.stopped || entry.label) return undefined
    const request = this.options.requests
      .snapshot()
      .find((request) => request.id === entry.request.id)
    return request && !request.submitting && Date.now() < request.expiresAt ? request : undefined
  }
  private resolved(resolution: RequestResolution): void {
    const entry = this.entries.get(resolution.id)
    if (!entry) return
    const label =
      resolution.outcome === 'confirmed' && resolution.origin
        ? `✅ Answered in ${resolution.origin === 'telegram' ? 'Telegram' : 'Buddy'}`
        : resolution.outcome === 'expired'
          ? '⏳ Expired in Buddy. Check the agent’s native interface.'
          : 'ℹ️ No longer pending'
    this.retire(entry, label)
  }
  private retire(entry: Entry, label: string): void {
    if (entry.label) return
    entry.label = label
    entry.answers = entry.request.questions.map(() => [])
    for (const [id, prompt] of this.prompts) if (prompt.entry === entry) this.prompts.delete(id)
    this.refresh(entry)
  }
  reconcile(sessions: readonly SessionRecord[], preferences: TelegramPreferences): void {
    if (this.stopped) return
    const pending = this.options.requests.snapshot()
    for (const entry of this.entries.values()) {
      const request = pending.find((item) => item.id === entry.request.id)
      const session = sessions.find((item) => item.id === request?.sessionId)
      const title = session ? sessionContext(session, sessions) : entry.title
      if (!request) this.retire(entry, 'ℹ️ No longer pending')
      else if (Date.now() >= request.expiresAt)
        this.retire(
          entry,
          request.deadlineSource === 'buddy'
            ? '⏳ Expired in Buddy. Check the agent’s native interface.'
            : 'ℹ️ No longer pending',
        )
      else if (
        request.submitting !== entry.request.submitting ||
        request.error !== entry.request.error ||
        title !== entry.title
      ) {
        entry.request = request
        entry.title = title
        this.refresh(entry)
      } else entry.request = request // Includes renewed connection-specific deadlines.
    }
    // Bound retired state even while notifications are paused.
    for (const [id, entry] of this.entries)
      if (
        entry.label &&
        !entry.rendering &&
        !entry.dirty &&
        !entry.editFailed &&
        !pending.some((p) => p.id === id)
      ) {
        this.entries.delete(id)
        this.options.changed()
      }
    if (preferences.paused) return
    for (const request of pending) {
      if (
        this.entries.has(request.id) ||
        this.entries.size >= 128 ||
        request.submitting ||
        Date.now() >= request.expiresAt ||
        !preferences[request.kind === 'permission' ? 'permissions' : 'questions']
      )
        continue
      const entry: Entry = {
        request,
        title: sessionContext(
          sessions.find((s) => s.id === request.sessionId),
          sessions,
          request.harness,
        ),
        answers: request.questions.map(() => []),
        question: 0,
        revision: 0,
        rendering: false,
        dirty: false,
        label: null,
        sendUnconfirmed: false,
        editFailed: false,
        handles: [],
      }
      this.entries.set(request.id, entry)
      this.refresh(entry)
    }
  }
  private content(entry: Entry): { text: string; buttons: { text: string; action: Action }[][] } {
    const r = entry.request
    const heading =
      entry.label ?? (r.kind === 'permission' ? '🔐 Permission requested' : '💬 Answer needed')
    let text = `${heading}\n\n${entry.title}\n\n${r.tool ? `Tool: ${r.tool}\n\n` : ''}${r.details}`
    const buttons: { text: string; action: Action }[][] = []
    if (r.kind === 'question') {
      for (const [index, question] of r.questions.entries()) {
        text += `\n\nQuestion ${index + 1} of ${r.questions.length}\n${question.text}`
        for (const option of question.options)
          text += `\n• ${option.label}${option.description ? ` — ${option.description}` : ''}`
        text += `\nAnswer: ${entry.answers[index]?.join(', ') || '(not selected)'}`
      }
    }
    // Approval without the complete command/diff/question context is unsafe.
    if (text.length > 3400)
      return {
        text: `${heading}\n\n${entry.title}\n\nThis request is too large to review safely here. Open the agent’s native interface.`,
        buttons,
      }
    if (entry.label) return { text, buttons }
    if (r.submitting)
      return { text: `${text}\n\nResponse sent; awaiting the agent. ${r.error ?? ''}`, buttons }
    if (
      (r.kind === 'permission' && r.allowedDecisions?.length === 0) ||
      (r.kind === 'question' && r.questions.some((q) => !q.custom && !q.options.length))
    )
      return { text: `${text}\n\nAnswer in the agent’s native interface.`, buttons }
    if (r.kind === 'permission') {
      for (const decision of r.allowedDecisions ?? ['allow', 'reject'])
        buttons.push([
          {
            text: decision === 'allow' ? (r.allowLabel ?? 'Allow once') : 'Reject',
            action: { decision },
          },
        ])
    } else {
      const q = r.questions[entry.question]
      if (!q) return { text: `${text}\n\nAnswer in the agent’s native interface.`, buttons }
      text += `\n\nAnswering question ${entry.question + 1} of ${r.questions.length}. ${q.multiple ? 'Select all that apply.' : 'Choose one answer.'} Submit when all answers are ready.`
      for (const [index, option] of q.options.entries())
        buttons.push([
          {
            text: `${entry.answers[entry.question]?.includes(option.label) ? '✓ ' : ''}${option.label}`.slice(
              0,
              60,
            ),
            action: { option: index },
          },
        ])
      if (q.custom) buttons.push([{ text: 'Type an answer…', action: { custom: true } }])
      buttons.push(
        r.questions.map((_, index) => ({
          text: `${index + 1}${entry.answers[index]?.length ? ' ✓' : ''}`,
          action: { question: index },
        })),
      )
      buttons.push([{ text: 'Submit all answers', action: { submit: true } }])
    }
    return { text: `${text}${r.error ? `\n\n${r.error}` : ''}`, buttons }
  }
  private refresh(entry: Entry): void {
    this.invalidate(entry)
    if (entry.sendUnconfirmed) return
    entry.dirty = true
    if (!entry.rendering) void this.render(entry)
  }
  private async render(entry: Entry): Promise<void> {
    entry.rendering = true
    try {
      while (entry.dirty && !this.stopped) {
        entry.dirty = false
        const revision = entry.revision
        const { text, buttons } = this.content(entry)
        const handles: { key: string; action: Action }[] = []
        const keyboard = buttons.map((row) =>
          row.map((button) => {
            const key = randomBytes(12).toString('base64url')
            handles.push({ key, action: button.action })
            return { text: button.text, callback_data: key }
          }),
        )
        let result: unknown
        try {
          result = await this.options.send(
            entry.message ? 'editMessageText' : 'sendMessage',
            {
              chat_id: this.options.pair.chat,
              ...(entry.message ? { message_id: entry.message } : {}),
              text,
              reply_markup: { inline_keyboard: keyboard },
              link_preview_options: { is_disabled: true },
            },
            () => !this.stopped && revision === entry.revision,
          )
        } catch (error) {
          // A newer render can invalidate queued work before it is sent. Keep
          // the latest edit, rather than dropping a retirement behind a draft.
          if (
            !this.stopped &&
            revision !== entry.revision &&
            (error instanceof TelegramCancelled || entry.message)
          ) {
            entry.dirty = true
            continue
          }
          throw error
        }
        if (!entry.message && record(result) && integer(result.message_id)) {
          entry.message = result.message_id
          this.options.remember({
            chat: this.options.pair.chat,
            message: entry.message,
            at: Date.now(),
          })
        }
        if (this.stopped) return
        if (!entry.message) throw new Error('Message delivery was not confirmed.')
        if (revision !== entry.revision) {
          entry.dirty = true
          continue
        }
        entry.editFailed = false
        this.options.changed()
        if (this.live(entry))
          for (const handle of handles) {
            this.handles.set(handle.key, { entry, action: handle.action, revision })
            entry.handles.push(handle.key)
          }
        if (entry.label) this.options.forget(entry.message)
      }
    } catch {
      this.invalidate(entry)
      // A failed edit never leaves local answer authority. Cleanup on restart
      // uses persisted IDs; ambiguous sends are never repeated automatically.
      entry.sendUnconfirmed = !entry.message
      entry.editFailed = !!entry.message
      entry.dirty = false
      this.options.error()
    } finally {
      entry.rendering = false
    }
  }
  async callback(data: unknown, message: unknown): Promise<void> {
    if (
      typeof data !== 'string' ||
      data.length > 64 ||
      !record(message) ||
      !record(message.chat) ||
      message.chat.type !== 'private' ||
      message.chat.id !== this.options.pair.chat ||
      !record(message.from) ||
      message.from.id !== this.options.botId
    )
      return
    const handle = this.handles.get(data)
    if (
      !handle ||
      handle.entry.message !== message.message_id ||
      handle.revision !== handle.entry.revision
    )
      return
    const { entry, action } = handle
    const live = this.live(entry)
    if (!live) {
      this.retire(entry, 'ℹ️ No longer pending')
      return
    }
    // Invalidate before any await, including custom prompt delivery.
    this.invalidate(entry)
    if ('decision' in action || 'submit' in action) {
      const response: AgentResponse = 'decision' in action ? action : { answers: entry.answers }
      try {
        validateResponse(live, response)
        await this.options.requests.respond(live.id, response, 'telegram')
        entry.request = { ...live, submitting: true }
      } catch {
        entry.request = {
          ...live,
          error: 'Answer not sent. Complete every answer or check the agent’s current request.',
        }
      }
    } else if ('question' in action) entry.question = action.question
    else if ('option' in action) {
      const q = live.questions[entry.question]!
      const label = q.options[action.option]?.label
      if (label) {
        const current = entry.answers[entry.question]!
        entry.answers[entry.question] = q.multiple
          ? current.includes(label)
            ? current.filter((v) => v !== label)
            : [...current, label].slice(0, 16)
          : [label]
      }
    } else if ('custom' in action) {
      const question = entry.question
      if (!live.questions[question]?.custom) return
      try {
        const prompt = await this.options.send(
          'sendMessage',
          {
            chat_id: this.options.pair.chat,
            text: `✏️ Your answer\n\n${entry.title}\n\nQuestion ${question + 1} of ${live.questions.length}\n${live.questions[question]!.text.slice(0, 3000)}\n\nReply directly to this message.${live.questions[question]!.multiple ? ' This replaces your selections for this question.' : ''} Then use Submit all answers on the original message.`,
            reply_markup: { force_reply: true, selective: true },
          },
          () => !!this.live(entry),
        )
        if (record(prompt) && integer(prompt.message_id) && this.live(entry)) {
          for (const [id, value] of this.prompts)
            if (value.entry === entry && value.question === question) this.prompts.delete(id)
          if (this.prompts.size >= 128) this.prompts.delete(this.prompts.keys().next().value!)
          this.prompts.set(prompt.message_id, { entry, question })
        }
      } catch {
        this.options.error()
      }
    }
    if (!this.stopped) this.refresh(entry)
  }
  reply(message: Record<string, unknown>): void {
    const reply = message.reply_to_message
    if (
      !record(reply) ||
      !integer(reply.message_id) ||
      !record(reply.from) ||
      reply.from.id !== this.options.botId ||
      typeof message.text !== 'string' ||
      !message.text.trim() ||
      message.text.length > 4096
    )
      return
    const prompt = this.prompts.get(reply.message_id)
    if (!prompt || !this.live(prompt.entry)) return
    this.prompts.delete(reply.message_id)
    prompt.entry.answers[prompt.question] = [message.text]
    this.refresh(prompt.entry)
  }
  hasMessage(message: number): boolean {
    return [...this.entries.values()].some((entry) => entry.message === message)
  }
  hasDeliveryProblem(): boolean {
    return [...this.entries.values()].some(
      (entry) => entry.editFailed || (entry.sendUnconfirmed && !entry.label),
    )
  }
  recoverEdits(): void {
    // Edits are idempotent; uncertain sends and agent mutations are not.
    for (const entry of this.entries.values())
      if (entry.editFailed && !entry.rendering) this.refresh(entry)
  }
  dispose(): void {
    this.stopped = true
    this.unsubscribe()
    this.handles.clear()
    this.prompts.clear()
    this.entries.clear()
  }
}
