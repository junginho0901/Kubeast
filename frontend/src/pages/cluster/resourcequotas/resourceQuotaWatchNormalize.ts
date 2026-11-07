// ResourceQuota watch event → the list's row, and applying it to the list.

import type { ResourceQuotaInfo } from '@/services/api'
import { applyRowEvent } from '@/services/applyRowEvent'

export function normalizeWatchResourceQuotaObject(obj: any): ResourceQuotaInfo {
  if (typeof obj?.name === 'string' && typeof obj?.namespace === 'string' && typeof obj?.status_hard === 'object') {
    return obj as ResourceQuotaInfo
  }
  const metadata = obj?.metadata ?? {}
  const status = obj?.status ?? {}

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    status_hard: status?.hard ?? {},
    status_used: status?.used ?? {},
    labels: metadata?.labels ?? obj?.labels ?? {},
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
  }
}

export function applyResourceQuotaWatchEvent(
  prev: ResourceQuotaInfo[] | undefined,
  event: { type?: string; object?: any },
): ResourceQuotaInfo[] {
  return applyRowEvent(prev, event, normalizeWatchResourceQuotaObject)
}
