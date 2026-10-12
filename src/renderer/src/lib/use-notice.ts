import { useEffect, useState } from 'react'
import type { NoticeMessage } from '@/components/ui/notice'
import { errorMessage } from '@shared/error-message'

export function useNotice() {
  const [notice, setNotice] = useState<NoticeMessage | null>(null)
  useEffect(() => {
    if (!notice || notice.error) return
    const timer = setTimeout(() => setNotice(null), 5000)
    return () => clearTimeout(timer)
  }, [notice])
  return {
    notice,
    setNotice,
    clearNotice: () => setNotice(null),
    reportError: (error: unknown, fallback: string) =>
      setNotice({ error: true, text: errorMessage(error, fallback) }),
  }
}
