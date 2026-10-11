import type { ComponentProps } from 'react'
import type { SessionSignal } from '@shared/sessions'
import { cn } from '@/lib/utils'

export function SignalBoundary({
  signal,
  revision,
  className,
  children,
  ...props
}: ComponentProps<'div'> & { signal?: SessionSignal; revision?: string }) {
  return (
    <div className={cn('signal-boundary', className)} data-signal={signal} {...props}>
      {signal && (
        <span key={`${signal}:${revision ?? ''}`} className="signal-trace" aria-hidden="true" />
      )}
      {children}
    </div>
  )
}
