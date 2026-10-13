import type { AvatarPreview, HarnessCatalogEntry } from '@shared/contracts'
import { cn } from '@/lib/utils'
import { useEffect, useState } from 'react'

const cache = new Map<string, string>()
const loading = new Map<string, Promise<string>>()

export function SessionAvatar({
  avatar,
  harness,
  className,
  compactBadge = false,
  notchBadge = false,
}: {
  avatar: AvatarPreview & { id?: string }
  harness: HarnessCatalogEntry
  className?: string
  compactBadge?: boolean
  notchBadge?: boolean
}) {
  const [loaded, setLoaded] = useState<{ id: string; uri: string } | null>(null)
  const id = avatar.id
  useEffect(() => {
    if (avatar.dataUri || !id) return
    if (cache.has(id)) {
      setLoaded({ id, uri: cache.get(id)! })
      return
    }
    let active = true
    if (!loading.has(id)) {
      const request = window.buddy
        .getSessionAvatar(id)
        .then((uri) => {
          if (cache.size >= 2000) cache.delete(cache.keys().next().value!)
          cache.set(id, uri)
          return uri
        })
        .finally(() => loading.delete(id))
      loading.set(id, request)
    }
    void loading
      .get(id)!
      .then((uri) => {
        if (active) setLoaded({ id, uri })
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [id, avatar.dataUri])
  const uri = avatar.dataUri || (id && cache.get(id)) || (loaded?.id === id ? loaded?.uri : null)
  return (
    <div className={cn('relative shrink-0 rounded-xl bg-secondary', className)}>
      {uri && (
        <img
          src={uri}
          alt={`${harness.name} avatar`}
          className="size-full rounded-[26%]"
          draggable={false}
        />
      )}
      <span
        className={cn(
          'absolute flex items-center justify-center border-background bg-foreground font-mono font-semibold text-background',
          notchBadge
            ? 'bottom-0 left-0 h-2.5 w-3 rounded-sm border text-[5px]'
            : compactBadge
              ? '-right-1 -bottom-1 size-4 rounded-md border text-[7px]'
              : '-right-2 -bottom-2 h-6 min-w-7 rounded-lg border-2 px-1 text-[10px]',
        )}
        role="img"
        aria-label={`${harness.name} harness`}
        title={harness.name}
      >
        {harness.shortLabel}
      </span>
    </div>
  )
}
