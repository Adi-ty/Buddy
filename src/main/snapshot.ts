import { app } from 'electron'
import type { BuddySnapshot, HarnessCatalogEntry } from '../shared/contracts'
import { createAvatarPreviews } from './avatars'

const harnesses: HarnessCatalogEntry[] = [
  {
    id: 'codex',
    name: 'Codex',
    shortLabel: 'CX',
    description: 'Local CLI hooks first. Desktop and IDE runtimes are verified separately.',
    connection: 'not-connected',
    installation: 'not-checked',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    shortLabel: 'CC',
    description: 'Observation hooks for local Code sessions. Chat and Cowork are separate.',
    connection: 'not-connected',
    installation: 'not-checked',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    shortLabel: 'OC',
    description: 'Local plugin events first. Server connections have their own coverage.',
    connection: 'not-connected',
    installation: 'not-checked',
  },
]

export function createInitialSnapshot(): BuddySnapshot {
  return {
    revision: 0,
    coverage: 'not-connected',
    sessions: [],
    history: [],
    harnesses,
    avatarPreviews: createAvatarPreviews(),
    overlay: {
      mode: 'idle',
      displayId: null,
      clickThrough: false,
      geometry: 'loading',
      message: null,
      displays: [],
      anchorId: null,
      expanded: false,
      visible: false,
      actualBounds: null,
      shortcutAvailable: false,
      previewSessions: [],
    },
    runtime: {
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
      packaged: app.isPackaged,
      overlayPreviewEnabled: !app.isPackaged || process.argv.includes('--overlay-preview'),
    },
  }
}
