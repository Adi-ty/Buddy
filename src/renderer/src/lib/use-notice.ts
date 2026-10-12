import { useState } from 'react'
import type { NoticeMessage } from '@/components/ui/notice'
import { errorMessage } from '@shared/error-message'

export function useNotice() {
  const [notice, setNotice] = useState<NoticeMessage | null>(null)
  return {
    notice,
    setNotice,
    clearNotice: () => setNotice(null),
    reportError: (error: unknown, fallback: string) =>
      setNotice({ error: true, text: errorMessage(error, fallback) }),
  }
}
