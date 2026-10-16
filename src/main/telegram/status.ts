import { randomBytes } from 'node:crypto'
import type { SessionRecord } from '../../shared/contracts'
import { relativeTime, sessionFamilies } from '../../shared/session-families'
import { sessionLastTool, sessionStatusLabels } from '../../shared/sessions'
import { ADAPTERS } from '../tracking/adapters'
import { integer, record } from './client'

const HELP = [
  'Buddy · Help',
  '',
  '/status — View your sessions',
  '/help — Show commands',
  '',
  'Answer requests using their notification buttons.',
  'Keep Buddy running and your Mac awake, online and connected to your agent.',
].join('\n')

const icons: Record<SessionRecord['status'], string> = {
  working: '🔵',
  idle: '⚪',
  completed: '✅',
  'needs-attention': '💬',
  error: '❌',
  interrupted: '⏸',
  unknown: '❔',
}
const label = (value: string, limit = 100): string => {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length <= limit
    ? text
    : `${text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '')}…`
}

export interface StatusSnapshot {
  sessions: readonly SessionRecord[]
  available: boolean
  paused: boolean
}

export function statusPage(snapshot: StatusSnapshot, requestedPage: number, now = Date.now()) {
  // History is deliberately excluded, including from family lookup. An orphan
  // remains visible as a subagent rather than inventing a live parent session.
  const families = snapshot.available
    ? sessionFamilies(snapshot.sessions.filter((s) => s.presence === 'observed'))
    : []
  const priority = (status: SessionRecord['status']) =>
    status === 'needs-attention' ? 0 : status === 'working' ? 1 : status === 'error' ? 2 : 3
  families.sort((a, b) => priority(a.summary.status) - priority(b.summary.status))
  const pages = Math.max(1, Math.ceil(families.length / 5))
  const page = Math.min(Math.max(0, requestedPage), pages - 1)
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(now)
  const blocks = families.slice(page * 5, page * 5 + 5).map(({ root, summary, members }) => {
    const orphan = root.parentId && root.parentId !== root.id
    const tool = sessionLastTool(root)
    const children = members.filter((s) => s.id !== root.id)
    const counts = new Map<string, number>()
    for (const child of children) {
      const state = sessionStatusLabels[child.status].toLowerCase()
      counts.set(state, (counts.get(state) ?? 0) + 1)
    }
    const attention =
      summary.status === 'needs-attention'
        ? summary.attention.some((a) => a.kind === 'question')
          ? 'Waiting for your answer'
          : summary.attention.some((a) => a.kind === 'permission')
            ? 'Waiting for permission'
            : 'Needs attention'
        : null
    return [
      `${icons[summary.status]} ${label(root.name) || 'Unnamed session'}${orphan ? ' · Subagent' : ''}`,
      `${ADAPTERS[root.harness].name} · ${label(root.project, 80) || 'Unknown project'}`,
      // A child's state must not imply that the parent's last tool is running.
      root.status === 'needs-attention'
        ? attention || 'Needs attention'
        : sessionStatusLabels[root.status],
      ...(attention && root.status !== 'needs-attention'
        ? [`Subagent: ${attention.toLowerCase()}`]
        : []),
      ...(tool ? [`Last observed tool: ${label(tool, 80)}`] : []),
      `Last activity: ${relativeTime(root.lastSeen, now)}`,
      ...(children.length
        ? [`Subagents: ${[...counts].map(([state, count]) => `${count} ${state}`).join(' · ')}`]
        : []),
      ...(orphan ? ['Parent is not observed'] : []),
    ].join('\n')
  })
  return {
    page,
    pages,
    text: [
      'Buddy · Session status',
      `Snapshot: ${time}`,
      ...(snapshot.paused ? ['New alerts paused'] : []),
      '',
      ...(!snapshot.available
        ? ['Agent tracking is unavailable. Check Buddy on your Mac.']
        : !families.length
          ? ['No observed sessions.']
          : [blocks.join('\n\n')]),
      ...(pages > 1 ? ['', `Page ${page + 1} of ${pages}`] : []),
    ].join('\n'),
  }
}

interface View {
  handle: string
  message?: number
  createdAt: number
  content?: string
}

// Read-only navigation has separate, bounded authority from request buttons.
// Nothing is persisted: old views direct the user to /status after a restart.
export class TelegramStatusView {
  private readonly views = new Map<string, View>()
  private disposed = false
  private active: 'status' | 'help' | 'welcome' | null = null
  private pending: 'status' | 'help' | 'welcome' | null = null
  constructor(
    private readonly options: {
      chat: number
      botId: number
      snapshot: () => StatusSnapshot
      send: (
        method: string,
        body: Record<string, unknown>,
        valid: () => boolean,
      ) => Promise<unknown>
    },
  ) {}

  private prune(): void {
    for (const [handle, view] of this.views)
      if (Date.now() - view.createdAt >= 86_400_000) this.views.delete(handle)
    while (this.views.size > 16) this.views.delete(this.views.keys().next().value!)
  }

  private run(kind: 'status' | 'help' | 'welcome', work: () => Promise<void>): void {
    // Coalesce rapid commands/taps instead of queuing browsing ahead of answers.
    if (this.active || this.disposed) return
    this.active = kind
    void work()
      .catch(() => {})
      .finally(() => {
        this.active = null
        const pending = this.pending
        this.pending = null
        if (pending) this.open(pending)
      })
  }

  open(kind: 'status' | 'help' | 'welcome'): void {
    // Preserve a different command arriving during welcome/help delivery, but
    // collapse repeated /status commands into the already-running operation.
    if (this.active) {
      if (kind !== this.active) this.pending = kind
      return
    }
    this.run(kind, async () => {
      const view: View = { handle: randomBytes(12).toString('base64url'), createdAt: Date.now() }
      this.views.set(view.handle, view)
      this.prune()
      await this.render(view, 0, kind)
    })
  }

  callback(data: string, message: unknown): string | undefined {
    this.prune()
    const match = /^st:([\w-]{16}):(\d{1,4})$/.exec(data)
    const view = match && this.views.get(match[1]!)
    if (
      this.disposed ||
      !view ||
      !integer(view.message) ||
      !record(message) ||
      !record(message.chat) ||
      message.chat.type !== 'private' ||
      message.chat.id !== this.options.chat ||
      message.message_id !== view.message ||
      !record(message.from) ||
      message.from.id !== this.options.botId
    )
      return 'This view is unavailable. Send /status for a new one.'
    this.run('status', () => this.render(view, Number(match![2]), 'status'))
    return undefined
  }

  private async render(
    view: View,
    page: number,
    kind: 'status' | 'help' | 'welcome',
  ): Promise<void> {
    const status = statusPage(this.options.snapshot(), page)
    const button = (text: string, target: number) => ({
      text,
      callback_data: `st:${view.handle}:${target}`,
    })
    const keyboard =
      kind === 'status'
        ? [
            ...(status.pages > 1
              ? [
                  [
                    ...(status.page > 0 ? [button('‹ Previous', status.page - 1)] : []),
                    ...(status.page + 1 < status.pages ? [button('Next ›', status.page + 1)] : []),
                  ],
                ]
              : []),
            [button('Refresh', status.page)],
          ]
        : [[button('View status', 0)]]
    const body = {
      chat_id: this.options.chat,
      text:
        kind === 'status'
          ? status.text
          : kind === 'help'
            ? HELP
            : 'Paired with Buddy.\n\nView your sessions with /status. Answer requests using their notification buttons.\n\nKeep Buddy running and your Mac awake, online and connected to your agent.',
      reply_markup: { inline_keyboard: keyboard },
      link_preview_options: { is_disabled: true },
    }
    const content = JSON.stringify(body)
    if (view.content === content) return
    const valid = () => !this.disposed && this.views.get(view.handle) === view
    const result = await this.options.send(
      view.message === undefined ? 'sendMessage' : 'editMessageText',
      { ...body, ...(view.message === undefined ? {} : { message_id: view.message }) },
      valid,
    )
    if (!valid()) return
    if (view.message === undefined) {
      if (!record(result) || !integer(result.message_id)) return
      view.message = result.message_id
    }
    view.content = content
  }

  dispose(): void {
    this.disposed = true
    this.views.clear()
  }
}
