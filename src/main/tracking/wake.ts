import type { SessionStore } from './store'
import { runTask } from '../tasks'

export function observeWake(
  power: {
    on(event: 'resume', listener: () => void): unknown
    removeListener(event: 'resume', listener: () => void): unknown
  },
  store: Pick<SessionStore, 'expire'>,
  publish: () => void,
): () => void {
  // Unlock alone says nothing about session freshness. On wake only records
  // past the ordinary inactivity deadline expire; fresh activity wins.
  const resume = () =>
    runTask('Wake reconciliation', () => {
      if (store.expire()) publish()
    })
  power.on('resume', resume)
  return () => {
    power.removeListener('resume', resume)
  }
}
