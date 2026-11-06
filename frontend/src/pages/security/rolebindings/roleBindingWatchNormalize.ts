// RoleBinding and ClusterRoleBinding watch event → the list's row, and applying it to the list.

import type { ClusterRoleBindingInfo, RoleBindingInfo } from '@/services/api'
import { applyRowEvent } from '@/services/applyRowEvent'

function bindingFields(obj: any) {
  const metadata = obj?.metadata ?? {}
  const subjects = Array.isArray(obj?.subjects) ? obj.subjects : []
  const roleRef = obj?.roleRef ?? {}

  return {
    name: metadata?.name ?? obj?.name ?? '',
    role_ref_kind: roleRef?.kind ?? obj?.role_ref_kind ?? '',
    role_ref_name: roleRef?.name ?? obj?.role_ref_name ?? '',
    subjects_count: subjects.length,
    subjects,
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
    labels: metadata?.labels ?? obj?.labels ?? null,
    annotations: metadata?.annotations ?? obj?.annotations ?? null,
  }
}

export function normalizeWatchRoleBindingObject(obj: any): RoleBindingInfo {
  if (typeof obj?.name === 'string' && typeof obj?.namespace === 'string' && typeof obj?.subjects_count === 'number') {
    return obj as RoleBindingInfo
  }
  return { ...bindingFields(obj), namespace: obj?.metadata?.namespace ?? obj?.namespace ?? '' }
}

export function normalizeWatchClusterRoleBindingObject(obj: any): ClusterRoleBindingInfo {
  if (typeof obj?.name === 'string' && typeof obj?.subjects_count === 'number') {
    return obj as ClusterRoleBindingInfo
  }
  return bindingFields(obj)
}

export function applyRoleBindingWatchEvent(
  prev: RoleBindingInfo[] | undefined,
  event: { type?: string; object?: any },
): RoleBindingInfo[] {
  return applyRowEvent(prev, event, normalizeWatchRoleBindingObject)
}

export function applyClusterRoleBindingWatchEvent(
  prev: ClusterRoleBindingInfo[] | undefined,
  event: { type?: string; object?: any },
): ClusterRoleBindingInfo[] {
  return applyRowEvent(prev, event, normalizeWatchClusterRoleBindingObject)
}
