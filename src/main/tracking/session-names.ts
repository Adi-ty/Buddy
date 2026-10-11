import { closeSync, openSync, readSync, statSync } from 'node:fs'
import type { HarnessId } from '../../shared/contracts'
import { textField } from './events'
import { HARNESSES } from './adapters'
import { displayTitle, TitleStorage } from './title-storage'

// Codex's title-only index is optional metadata, never evidence of a live
// session. Read a bounded tail and ignore partial lines; no transcript access.
export class SessionNames {
  private stamp = ''
  private titles = new Map<string, string>()
  private storage = new TitleStorage()

  constructor(private readonly indexOverride?: string) {}

  lookup(harness: HarnessId, sessionId: string, cwd?: string | null): string | null {
    const adapter = HARNESSES.find((entry) => entry.id === harness)
    const storage = adapter?.nameStorage
    if (storage?.kind === 'opencode-db') return this.storage.opencode(storage.path(), sessionId)
    if (storage?.kind === 'claude-titles')
      return this.storage.claude(storage.path(), sessionId, cwd)
    const index = adapter?.nameIndex
    if (!index) return null
    const indexPath = this.indexOverride ?? index.path()
    let fd: number | undefined
    try {
      const stat = statSync(indexPath)
      if (!stat.isFile()) return null
      const stamp = `${harness}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
      if (stamp !== this.stamp) {
        fd = openSync(indexPath, 'r')
        const offset = Math.max(0, stat.size - 1024 * 1024)
        const buffer = Buffer.alloc(Math.min(stat.size, 1024 * 1024))
        const bytes = readSync(fd, buffer, 0, buffer.length, offset)
        const lines = buffer.subarray(0, bytes).toString('utf8').split('\n')
        if (offset) lines.shift()
        const titles = new Map<string, string>()
        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as Record<string, unknown>
            const id = textField(entry?.[index.idField], 128)
            const title = displayTitle(entry?.[index.nameField])
            if (id && title?.trim()) titles.set(id, title.trim())
          } catch {
            // An in-progress append or unsupported index entry is harmless.
          }
        }
        this.titles = titles
        this.stamp = stamp
      }
      return this.titles.get(sessionId) ?? null
    } catch {
      return null
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }

  dispose(): void {
    this.storage.dispose()
  }
}
