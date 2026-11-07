// Pod watch event → 기존 list state 에 반영 (useKubeWatchList 의 applyEvent 콜백).

import type { PodInfo } from '@/services/api'

export function applyPodWatchEvent(prev: PodInfo[] | undefined, event: { type?: string; object?: any }): PodInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const row = event?.object as PodInfo | undefined
  if (!row) return items

  const name = row.name
  const namespace = row.namespace
  if (!name || !namespace) return items

  const key = `${namespace}/${name}`
  const index = items.findIndex((item) => `${item.namespace}/${item.name}` === key)

  if (event.type === 'DELETED') {
    if (index >= 0) items.splice(index, 1)
    return items
  }

  // the server sends the whole row (podrow.Info), so it replaces: a reason, owner or label that went away goes
  if (index >= 0) {
    items[index] = row
  } else {
    items.push(row)
  }
  return items
}
