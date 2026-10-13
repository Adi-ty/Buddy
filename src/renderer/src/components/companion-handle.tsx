import { useEffect, useRef, type ReactNode } from 'react'
import { GripVertical } from 'lucide-react'
import type { CompanionMove } from '@shared/companion'
import { cn } from '@/lib/utils'

export function CompanionHandle({
  children,
  className,
  onError,
}: {
  children: ReactNode
  className?: string
  onError: (error: unknown) => void
}) {
  const captured = useRef<number | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const cancel = () => {
      if (captured.current === null) return
      const pointer = captured.current
      captured.current = null
      if (button.current?.hasPointerCapture(pointer)) button.current.releasePointerCapture(pointer)
      void window.buddy.moveCompanion('cancel').catch(() => {})
    }
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('blur', cancel)
      cancel()
    }
  }, [])
  const finish = (cancel: boolean) => {
    if (captured.current === null) return
    const pointer = captured.current
    captured.current = null
    if (button.current?.hasPointerCapture(pointer)) button.current.releasePointerCapture(pointer)
    void window.buddy.moveCompanion(cancel ? 'cancel' : 'finish').catch(onError)
  }
  return (
    <button
      ref={button}
      type="button"
      className={cn('companion-handle', className)}
      title="Hold and drag to move · Arrow keys when focused"
      aria-label="Move companion"
      onClick={(event) => {
        // Keyboard/assistive activation opts into focus; mouse dragging stays passive.
        if (event.detail === 0)
          void window.buddy
            .setOverlayInput(true)
            .then(() => button.current?.focus())
            .catch(onError)
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary || captured.current !== null) return
        event.preventDefault()
        captured.current = event.pointerId
        event.currentTarget.setPointerCapture(event.pointerId)
        void window.buddy.moveCompanion('start').catch((error) => {
          finish(true)
          onError(error)
        })
      }}
      onPointerUp={() => finish(false)}
      onPointerCancel={() => finish(true)}
      onLostPointerCapture={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && captured.current !== null) {
          event.preventDefault()
          finish(true)
          return
        }
        const direction = {
          ArrowLeft: 'left',
          ArrowRight: 'right',
          ArrowUp: 'up',
          ArrowDown: 'down',
        }[event.key]
        if (!direction) return
        event.preventDefault()
        void window.buddy.moveCompanion(direction as CompanionMove).catch(onError)
      }}
    >
      <GripVertical size={12} className="shrink-0 text-muted-foreground/60" aria-hidden="true" />
      {children}
    </button>
  )
}
