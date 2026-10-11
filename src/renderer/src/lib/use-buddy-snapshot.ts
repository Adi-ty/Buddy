import { useEffect, useState } from 'react'
import type { BuddySnapshot } from '@shared/contracts'

export function useBuddySnapshot() {
  const [snapshot, setSnapshot] = useState<BuddySnapshot | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let current = true
    const accept = (value: BuddySnapshot) => {
      if (current)
        setSnapshot((previous) =>
          !previous || value.revision >= previous.revision ? value : previous,
        )
    }
    // Subscribe before bootstrap, then reject older revisions. A display update
    // during the initial invoke cannot overwrite a newer renderer snapshot.
    const unsubscribe = window.buddy.onSnapshot(accept)
    void window.buddy
      .getSnapshot()
      .then(accept)
      .catch(() => {
        if (current) setFailed(true)
      })
    return () => {
      current = false
      unsubscribe()
    }
  }, [])
  return { snapshot, failed }
}
