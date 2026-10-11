import type { AvatarPreview, HarnessCatalogEntry } from '@shared/contracts'
import { cn } from '@/lib/utils'

export function SessionAvatar({
  avatar,
  harness,
  className,
  compactBadge = false,
}: {
  avatar: AvatarPreview
  harness: HarnessCatalogEntry
  className?: string
  compactBadge?: boolean
}) {
  return (
    <div className={cn('relative shrink-0', className)}>
      <img
        src={avatar.dataUri}
        alt={`${harness.name} avatar`}
        className="size-full rounded-[26%]"
        draggable={false}
      />
      <span
        className={cn(
          'absolute flex items-center justify-center border-background bg-foreground font-mono font-semibold text-background',
          compactBadge
            ? '-right-1 -bottom-1 size-4 rounded-md border text-[7px]'
            : '-right-2 -bottom-2 h-6 min-w-7 rounded-lg border-2 px-1 text-[10px]',
        )}
        aria-label={`${harness.name} harness`}
        title={harness.name}
      >
        {harness.shortLabel}
      </span>
    </div>
  )
}
