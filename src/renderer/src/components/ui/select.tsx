import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'max-w-full rounded-lg border border-border bg-card px-3 py-2 text-xs focus-visible:outline-ring',
        className,
      )}
      {...props}
    />
  )
}
