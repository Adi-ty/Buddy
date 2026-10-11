import { cn } from '@/lib/utils'

export interface NoticeMessage {
  text: string
  error: boolean
}
export function Notice({
  message,
  className,
}: {
  message: NoticeMessage | null
  className?: string
}) {
  if (!message) return null
  return (
    <p
      role={message.error ? 'alert' : 'status'}
      className={cn(
        'rounded-xl border border-border bg-card p-3 text-xs leading-5',
        message.error && 'text-error',
        className,
      )}
    >
      {message.text}
    </p>
  )
}
