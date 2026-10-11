import type { BuddySnapshot, HarnessCatalogEntry, AvatarPreview } from '@shared/contracts'

export function harnessFor(snapshot: BuddySnapshot, id: string): HarnessCatalogEntry {
  return (
    snapshot.harnesses.find((entry) => entry.id === id) ?? {
      id: id as HarnessCatalogEntry['id'],
      name: 'Unknown agent',
      shortLabel: '?',
      description: 'Agent metadata is unavailable.',
      connection: 'not-connected',
      installation: 'not-checked',
      observer: 'not-installed',
    }
  )
}

export function avatarFor(snapshot: BuddySnapshot, id: string): AvatarPreview {
  return (
    snapshot.avatarPreviews.find((avatar) => avatar.harness === id) ?? {
      harness: id as AvatarPreview['harness'],
      dataUri:
        'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"%3E%3Crect width="64" height="64" rx="16" fill="%23646769"/%3E%3Ccircle cx="22" cy="28" r="4" fill="white"/%3E%3Ccircle cx="42" cy="28" r="4" fill="white"/%3E%3Cpath d="M22 42h20" stroke="white" stroke-width="4"/%3E%3C/svg%3E',
    }
  )
}
