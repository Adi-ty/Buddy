import { app } from 'electron'
import type { BuddySnapshot, HarnessCatalogEntry } from '../shared/contracts'
import { createAvatarPreviews } from './avatars'
import { HARNESSES } from './tracking/adapters'

const harnesses: HarnessCatalogEntry[] = HARNESSES.map(({ id, name, shortLabel, description }) => ({
  id,
  name,
  shortLabel,
  description,
  connection: 'not-connected',
  installation: 'not-checked',
  observer: 'not-installed',
}))

export function createInitialSnapshot(): BuddySnapshot {
  return {
    revision: 0,
    coverage: 'not-connected',
    sessions: [],
    history: [],
    tracking: { available: false, phase: 'starting', message: 'Starting local observation…' },
    harnesses,
    avatarPreviews: createAvatarPreviews(),
    overlay: {
      geometry: 'loading',
      message: null,
      displays: [],
      anchorId: null,
      expanded: false,
      visible: false,
      actualBounds: null,
      shortcutAvailable: false,
    },
    runtime: {
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
      packaged: app.isPackaged,
    },
  }
}
