import type { SessionRecord } from '@shared/contracts'

export function sessionPage(
  records: readonly SessionRecord[],
  groupFor: (record: SessionRecord) => { key: string; label: string },
  requestedPage: number,
  pageSize = 10,
) {
  const allGroups = new Map<string, { label: string; items: SessionRecord[] }>()
  for (const record of records) {
    const { key, label } = groupFor(record)
    const group = allGroups.get(key) ?? { label, items: [] }
    group.items.push(record)
    allGroups.set(key, group)
  }
  const ordered = [...allGroups.values()].flatMap((group) => group.items)
  const pages = Math.max(1, Math.ceil(ordered.length / pageSize))
  const page = Math.max(0, Math.min(requestedPage, pages - 1))
  const visible = ordered.slice(page * pageSize, (page + 1) * pageSize)
  const ids = new Set(visible.map((record) => record.id))
  const groups = new Map<string, { label: string; items: SessionRecord[] }>()
  for (const [key, group] of allGroups) {
    const items = group.items.filter((record) => ids.has(record.id))
    if (!items.length) continue
    const continued = items[0]?.id !== group.items[0]?.id
    groups.set(key, {
      items,
      label: `${group.label}${continued && group.label ? ' (continued)' : ''}`,
    })
  }
  return { ordered, visible, groups, pages, page }
}

export function nextSessionRow(records: readonly SessionRecord[], id: string, key: string) {
  const index = records.findIndex((record) => record.id === id)
  if (index < 0) return undefined
  if (key === 'Home') return records[0]
  if (key === 'End') return records.at(-1)
  if (key === 'ArrowDown') return records[index + 1]
  if (key === 'ArrowUp') return records[index - 1]
  return undefined
}
