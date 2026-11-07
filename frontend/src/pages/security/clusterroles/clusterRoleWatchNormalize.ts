// ClusterRole watch event → the list's row, and applying it to the list.

import type { ClusterRoleInfo } from '@/services/api'
import { applyRowEvent } from '@/services/applyRowEvent'

export function normalizeWatchClusterRoleObject(obj: any): ClusterRoleInfo {
  if (typeof obj?.name === 'string' && typeof obj?.rules_count === 'number') {
    return obj as ClusterRoleInfo
  }

  const metadata = obj?.metadata ?? {}
  const rules = Array.isArray(obj?.rules) ? obj.rules : []

  return {
    name: metadata?.name ?? obj?.name ?? '',
    rules_count: rules.length,
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
    labels: metadata?.labels ?? obj?.labels ?? null,
    annotations: metadata?.annotations ?? obj?.annotations ?? null,
  }
}

export function applyClusterRoleWatchEvent(
  prev: ClusterRoleInfo[] | undefined,
  event: { type?: string; object?: any },
): ClusterRoleInfo[] {
  return applyRowEvent(prev, event, normalizeWatchClusterRoleObject)
}
