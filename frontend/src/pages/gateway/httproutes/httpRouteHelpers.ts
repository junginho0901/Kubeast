// HTTPRoutes 페이지의 helper 함수 및 type
//
// frontend/src/pages/gateway/HTTPRoutes.tsx 의 parseAgeSeconds / formatAge /
// formatHostnames / httpRouteToRawJson + SortKey 타입 추출.
// 순수 함수 + 타입 정의. formatHostnames 는 빈 배열일 때 '*' 표시.

import type { HTTPRouteInfo } from '@/services/api'

export type SortKey =
  | null
  | 'name'
  | 'namespace'
  | 'hostnames'
  | 'parents'
  | 'rules'
  | 'backends'
  | 'status'
  | 'age'

export { ageSeconds as parseAgeSeconds, formatAge } from '@/utils/time'

export function formatHostnames(item: HTTPRouteInfo): string {
  const list = Array.isArray(item.hostnames) ? item.hostnames : []
  if (list.length === 0) return '*'
  return list.map((h) => h || '*').join(', ')
}

export function httpRouteToRawJson(item: HTTPRouteInfo): Record<string, unknown> {
  return {
    apiVersion: item.api_version || 'gateway.networking.k8s.io/v1',
    kind: 'HTTPRoute',
    metadata: {
      name: item.name,
      namespace: item.namespace,
      labels: item.labels || {},
      annotations: item.annotations || {},
      finalizers: item.finalizers || [],
      creationTimestamp: item.created_at,
    },
    spec: {
      hostnames: item.hostnames || [],
      parentRefs: item.parent_refs || [],
      rules: item.rules || [],
    },
    status: {
      parents: item.parents || [],
    },
    rule_count: item.rule_count || 0,
    parent_refs_count: item.parent_refs_count || 0,
    backend_refs_count: item.backend_refs_count || 0,
    status_text: item.status,
    accepted: item.accepted,
    resolved_refs: item.resolved_refs,
    conditions: item.conditions || [],
  }
}
