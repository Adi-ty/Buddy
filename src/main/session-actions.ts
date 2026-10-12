import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { SESSION_ACTIONS } from '../shared/contracts'
import type { SessionStore } from './tracking/store'

export function performSessionAction(
  store: Pick<SessionStore, 'get'> | null,
  id: unknown,
  action: unknown,
  native: { writeText(text: string): void; showItemInFolder(path: string): void },
): void {
  if (
    typeof id !== 'string' ||
    id.length > 256 ||
    !SESSION_ACTIONS.some((value) => value === action)
  )
    throw new Error('Invalid session action')
  const record = store?.get(id)
  if (!record) throw new Error('Session is no longer available')
  if (action === 'copyId') return native.writeText(record.providerSessionId)
  if (!record.cwd || !isAbsolute(record.cwd)) throw new Error('Project path is unavailable')
  if (action === 'copyPath') return native.writeText(record.cwd)
  try {
    if (!statSync(record.cwd).isDirectory()) throw new Error('Missing folder')
  } catch {
    throw new Error('Project folder is unavailable. It may have moved or been deleted.')
  }
  native.showItemInFolder(record.cwd)
}
