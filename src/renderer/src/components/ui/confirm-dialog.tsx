import { useEffect, useRef } from 'react'
import { Button } from './button'

export function ConfirmDialog({
  title,
  children,
  action,
  pending,
  onConfirm,
  onCancel,
}: {
  title: string
  children: React.ReactNode
  action: string
  pending: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => {
      if (element?.open) element.close()
    }
  }, [])
  return (
    <dialog
      ref={dialog}
      className="confirm-dialog"
      aria-labelledby="confirm-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!pending) onCancel()
      }}
    >
      <h2 id="confirm-title" className="font-semibold">
        {title}
      </h2>
      <div className="mt-3 text-sm leading-6 text-muted-foreground">{children}</div>
      <div className="mt-5 flex justify-end gap-2">
        <Button autoFocus size="sm" variant="outline" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="danger" disabled={pending} onClick={onConfirm}>
          {pending ? 'Working…' : action}
        </Button>
      </div>
    </dialog>
  )
}
