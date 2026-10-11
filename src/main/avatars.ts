import { randomUUID } from 'node:crypto'
import { Avatar, Style } from '@dicebear/core'
import botttsNeutral from '@dicebear/styles/bottts-neutral.json' with { type: 'json' }
import type { AvatarPreview } from '../shared/contracts'
import { HARNESS_IDS } from '../shared/harnesses'

const style = new Style(botttsNeutral)
const palette = ['f2d3b1', 'b8dde8', 'cabde5', 'e8bbc8', 'c6dccb']

export function sessionAvatar(seed: string, ordinal: number): string {
  const svg = new Avatar(style, {
    seed,
    backgroundColor: [palette[ordinal % palette.length]!],
    textureProbability: 0,
  }).toString()
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

// These are explicitly UI previews, not canonical session identities. Actual
// session seeds will be allocated transactionally by the persistence layer.
export function createAvatarPreviews(): AvatarPreview[] {
  return HARNESS_IDS.map((harness, index) => {
    const svg = new Avatar(style, {
      seed: randomUUID(),
      backgroundColor: [palette[index % palette.length]!],
      textureProbability: 0,
    }).toString()

    return {
      harness,
      dataUri: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
    }
  })
}
