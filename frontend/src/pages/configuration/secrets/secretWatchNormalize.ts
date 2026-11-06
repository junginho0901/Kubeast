// Secret watch event → the list's row, and applying it to the list.

import type { SecretInfo } from '@/services/api'

export function normalizeWatchSecretObject(obj: any): SecretInfo {
  if (
    typeof obj?.name === 'string' &&
    typeof obj?.namespace === 'string' &&
    typeof obj?.type === 'string'
  ) {
    return obj as SecretInfo
  }

  const metadata = obj?.metadata ?? {}
  const data = obj?.data ?? {}

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    type: obj?.type ?? '',
    data_count: Object.keys(data).length,
    data_keys: Object.keys(data),
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
    labels: metadata?.labels ?? obj?.labels ?? null,
  }
}

export function applySecretWatchEvent(
  prev: SecretInfo[] | undefined,
  event: { type?: string; object?: any },
): SecretInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchSecretObject(obj)
  const name = normalized?.name
  const namespace = normalized?.namespace
  if (!name || !namespace) return items

  const key = `${namespace}/${name}`
  const index = items.findIndex((item) => `${item.namespace}/${item.name}` === key)

  if (event.type === 'DELETED') {
    if (index >= 0) items.splice(index, 1)
    return items
  }

  // the server sends the whole row (secretrow.Info), so it replaces: a key or label that went away shows that instead of
  // keeping the old one
  if (index >= 0) items[index] = normalized
  else items.push(normalized)

  return items
}
