// Role watch event → the list's row, and applying it to the list.

import type { RoleInfo } from '@/services/api'

export function normalizeWatchRoleObject(obj: any): RoleInfo {
  if (
    typeof obj?.name === 'string' &&
    typeof obj?.namespace === 'string' &&
    typeof obj?.rules_count === 'number'
  ) {
    return obj as RoleInfo
  }

  const metadata = obj?.metadata ?? {}
  const rules = Array.isArray(obj?.rules) ? obj.rules : []

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    rules_count: rules.length,
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
    labels: metadata?.labels ?? obj?.labels ?? null,
    annotations: metadata?.annotations ?? obj?.annotations ?? null,
  }
}

export function applyRoleWatchEvent(
  prev: RoleInfo[] | undefined,
  event: { type?: string; object?: any },
): RoleInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchRoleObject(obj)
  const name = normalized?.name
  const namespace = normalized?.namespace
  if (!name || !namespace) return items

  const key = `${namespace}/${name}`
  const index = items.findIndex((item) => `${item.namespace}/${item.name}` === key)

  if (event.type === 'DELETED') {
    if (index >= 0) items.splice(index, 1)
    return items
  }

  // the server sends the whole row (rolerow.Info), so it replaces: a label that went away shows that instead of keeping
  // the old one
  if (index >= 0) items[index] = normalized
  else items.push(normalized)

  return items
}
