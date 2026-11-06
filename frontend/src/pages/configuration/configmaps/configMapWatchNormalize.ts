// ConfigMap watch event → the list's row, and applying it to the list.

import type { ConfigMapInfo } from '@/services/api'

export function normalizeWatchConfigMapObject(obj: any): ConfigMapInfo {
  if (
    typeof obj?.name === 'string' &&
    typeof obj?.namespace === 'string' &&
    typeof obj?.data_count === 'number'
  ) {
    return obj as ConfigMapInfo
  }

  const metadata = obj?.metadata ?? {}
  const data = obj?.data ?? {}

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    data_count: typeof obj?.data_count === 'number' ? obj.data_count : Object.keys(data).length,
    data_keys: obj?.data_keys ?? Object.keys(data),
    binary_keys: obj?.binary_keys ?? [],
    labels: metadata?.labels ?? obj?.labels ?? null,
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
  }
}

export function applyConfigMapWatchEvent(
  prev: ConfigMapInfo[] | undefined,
  event: { type?: string; object?: any },
): ConfigMapInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchConfigMapObject(obj)
  const name = normalized?.name
  const namespace = normalized?.namespace
  if (!name || !namespace) return items

  const key = `${namespace}/${name}`
  const index = items.findIndex((item) => `${item.namespace}/${item.name}` === key)

  if (event.type === 'DELETED') {
    if (index >= 0) items.splice(index, 1)
    return items
  }

  // the server sends the whole row (configmaprow.Info), so it replaces: a key or label that went away shows that instead
  // of keeping the old one
  if (index >= 0) items[index] = normalized
  else items.push(normalized)

  return items
}
