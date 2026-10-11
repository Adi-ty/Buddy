import { useSyncExternalStore } from 'react'

export interface SessionFilters {
  harness: string
  project: string
  status: string
  recent: string
  groupBy: string
  sort: string
  search: string
}
const defaults: SessionFilters = {
  harness: 'all',
  project: 'all',
  status: 'all',
  recent: 'all',
  groupBy: 'none',
  sort: 'default',
  search: '',
}
const filters = { sessions: { ...defaults }, history: { ...defaults } }
const listeners = new Set<() => void>()

export function setSessionFilters(history: boolean, changes: Partial<SessionFilters>): void {
  const scope = history ? 'history' : 'sessions'
  filters[scope] = { ...filters[scope], ...changes }
  for (const listener of listeners) listener()
}

export function useSessionFilters(history: boolean) {
  const scope = history ? 'history' : 'sessions'
  const state = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => filters[scope],
    () => filters[scope],
  )
  const update = (changes: Partial<SessionFilters>): void => {
    setSessionFilters(history, changes)
  }
  return { ...state, update, reset: () => update(defaults) }
}
