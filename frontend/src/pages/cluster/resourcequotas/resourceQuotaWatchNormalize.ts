// ResourceQuotas 페이지 전용 watch event 정규화.
//
// ResourceQuotas.tsx 본체에서 분리. status.hard / status.used 두 map 보존.

import type { ResourceQuotaInfo } from '@/services/api'
import { mergeWatchUpdate } from '@/services/mergeWatchUpdate'

export function normalizeWatchResourceQuotaObject(obj: any): ResourceQuotaInfo {
  if (typeof obj?.name === 'string' && typeof obj?.namespace === 'string' && typeof obj?.created_at === 'string') {
    return obj as ResourceQuotaInfo
  }
  const metadata = obj?.metadata ?? {}
  const status = obj?.status ?? {}

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    status_hard: status?.hard ?? obj?.status_hard ?? {},
    status_used: status?.used ?? obj?.status_used ?? {},
    labels: metadata?.labels ?? obj?.labels ?? {},
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
  }
}

export function applyResourceQuotaWatchEvent(
  prev: ResourceQuotaInfo[] | undefined,
  event: { type?: string; object?: any },
): ResourceQuotaInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchResourceQuotaObject(obj)
  const name = normalized?.name
  const namespace = normalized?.namespace
  if (!name || !namespace) return items

  const key = `${namespace}/${name}`
  const index = items.findIndex((item) => `${item.namespace}/${item.name}` === key)

  if (event.type === 'DELETED') {
    if (index >= 0) items.splice(index, 1)
    return items
  }

  if (index >= 0) items[index] = mergeWatchUpdate(items[index], normalized)
  else items.push(normalized)

  return items
}
