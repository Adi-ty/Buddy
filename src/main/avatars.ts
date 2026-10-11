import { randomUUID } from 'node:crypto'
import { Avatar, Style } from '@dicebear/core'
import botttsNeutral from '@dicebear/styles/bottts-neutral.json' with { type: 'json' }
import type { AvatarPreview, HarnessId } from '../shared/contracts'

const style = new Style(botttsNeutral)
const palette = ['f2d3b1', 'b8dde8', 'cabde5', 'e8bbc8', 'c6dccb']

// These are explicitly UI previews, not canonical session identities. Actual
// session seeds will be allocated transactionally by the persistence layer.
export function createAvatarPreviews(): AvatarPreview[] {
  return (['codex', 'claude-code', 'opencode'] satisfies HarnessId[]).map((harness, index) => {
    const svg = new Avatar(style, {
      seed: randomUUID(),
      backgroundColor: [palette[index]!],
      textureProbability: 0,
    }).toString()

    return {
      harness,
      dataUri: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
    }
  })
}
