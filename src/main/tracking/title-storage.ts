import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { DatabaseSync } from 'node:sqlite'

export function displayTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return (
    value
      .replace(/[\u0000-\u001f]/g, ' ')
      .trim()
      .slice(0, 256) || null
  )
}

// Optional local metadata lookup for IDs that hooks/plugins have already
// observed. Neither reader imports conversations or establishes presence.
export class TitleStorage {
  private databases = new Map<
    string,
    { db: DatabaseSync; version: unknown; checked: number; titles: Map<string, string | null> }
  >()
  private files = new Map<
    string,
    { stamp: string; inode: number; size: number; custom: string | null; ai: string | null }
  >()
  private directories = new Map<string, { checked: number; names: string[] }>()
  private locations = new Map<string, { path: string | null; checked: number }>()

  opencode(path: string, id: string): string | null {
    try {
      if (!/^ses_[a-zA-Z0-9]+$/.test(id) || !statSync(path).isFile()) return null
      let source = this.databases.get(path)
      if (!source) {
        // Some Electron runtimes omit this builtin. Missing support must never
        // disable tracking or create a provider database.
        const { DatabaseSync: SQLite } = createRequire(import.meta.url)(
          'node:sqlite',
        ) as typeof import('node:sqlite')
        const db = new SQLite(path, { readOnly: true, timeout: 25 })
        source = { db, version: null, checked: 0, titles: new Map() }
        this.databases.set(path, source)
      }
      const now = Date.now()
      if (now - source.checked >= 1000) {
        const version = source.db.prepare('PRAGMA data_version').get()?.data_version
        if (version !== source.version) source.titles.clear()
        source.version = version
        source.checked = now
      }
      if (!source.titles.has(id)) {
        // The installed OpenCode schema is checked by prepare; an unsupported
        // schema fails quietly. Never select messages, prompts or tool output.
        const row = source.db.prepare('SELECT title FROM session WHERE id = ?').get(id)
        if (source.titles.size >= 2000) source.titles.clear()
        source.titles.set(id, displayTitle(row?.title))
      }
      return source.titles.get(id) ?? null
    } catch {
      return null
    }
  }

  claude(root: string, id: string, cwd?: string | null): string | null {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) return null
    const key = `${root}:${id}`
    const location = this.locations.get(key)
    if (location && Date.now() - location.checked < (location.path ? 15_000 : 5 * 60_000))
      return location.path ? this.claudeFile(location.path, id) : null
    let directories = this.directories.get(root)
    try {
      if (!directories || Date.now() - directories.checked >= 15_000) {
        directories = {
          checked: Date.now(),
          names: readdirSync(root, { withFileTypes: true })
            .filter((item) => item.isDirectory())
            .map((item) => item.name)
            .slice(0, 2000),
        }
        this.directories.set(root, directories)
      }
    } catch {
      this.locations.set(key, { path: null, checked: Date.now() })
      return null
    }
    let project: string | undefined
    try {
      if (cwd)
        project = realpathSync(cwd)
          .normalize('NFC')
          .replace(/[^a-zA-Z0-9]/g, '-')
    } catch {
      /* Search known metadata directories instead. */
    }
    const candidates = [
      ...new Set([...(project && project.length <= 200 ? [project] : []), ...directories.names]),
    ]
    for (const directory of candidates) {
      const path = join(root, directory, `${id}.jsonl`)
      if (!existsSync(path)) continue
      const title = this.claudeFile(path, id)
      if (this.files.has(path)) {
        this.locations.set(key, { path, checked: Date.now() })
        return title
      }
    }
    if (this.locations.size >= 2000) this.locations.clear()
    this.locations.set(key, { path: null, checked: Date.now() })
    return null
  }

  private claudeFile(path: string, id: string): string | null {
    let fd: number | undefined
    try {
      const stat = statSync(path)
      if (!stat.isFile()) return null
      const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`
      const previous = this.files.get(path)
      if (previous?.stamp === stamp) return previous.custom ?? previous.ai
      fd = openSync(path, 'r')
      const size = Math.min(65_536, stat.size)
      const head = Buffer.alloc(size)
      const tail = Buffer.alloc(size)
      const headBytes = readSync(fd, head, 0, size, 0)
      const offset = Math.max(0, stat.size - size)
      const tailBytes = readSync(fd, tail, 0, size, offset)
      const retained = previous?.inode === stat.ino && stat.size >= previous.size
      let custom = retained ? previous.custom : null
      let ai = retained ? previous.ai : null
      for (const [part, chunk] of [
        head.subarray(0, headBytes).toString('utf8'),
        tail.subarray(0, tailBytes).toString('utf8'),
      ].entries()) {
        for (const line of chunk.split('\n')) {
          // Only parse dedicated metadata records, never message objects or
          // a title-looking field inside a prompt/tool response.
          if (!/^\{\s*"type"\s*:\s*"(?:custom-title|ai-title)"\s*,/.test(line)) continue
          try {
            const entry = JSON.parse(line) as Record<string, unknown>
            if (entry.sessionId !== id) continue
            if (entry.type === 'custom-title' && !(part === 0 && retained && previous.custom))
              custom = displayTitle(entry.customTitle) ?? custom
            if (entry.type === 'ai-title' && !(part === 0 && retained && previous.ai))
              ai = displayTitle(entry.aiTitle) ?? ai
          } catch {
            /* Partial appends are ignored. */
          }
        }
      }
      if (this.files.size >= 2000) this.files.delete(this.files.keys().next().value!)
      this.files.set(path, { stamp, inode: stat.ino, size: stat.size, custom, ai })
      return custom ?? ai
    } catch {
      return null
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }

  dispose(): void {
    for (const { db } of this.databases.values()) {
      try {
        db.close()
      } catch {
        /* Already closed. */
      }
    }
    this.databases.clear()
    this.files.clear()
    this.directories.clear()
    this.locations.clear()
  }
}
