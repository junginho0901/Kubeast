// GRPCRoutes 페이지의 helper 함수 및 type
//
// frontend/src/pages/gateway/GRPCRoutes.tsx 의 parseAgeSeconds / formatAge /
// formatHostnames / grpcRouteToRawJson + SortKey 타입 추출.
// 순수 함수 + 타입 정의. HTTPRoutes 와 동일 구조 (Gateway API).
// formatHostnames 는 빈 배열일 때 '*' 표시.

import type { GRPCRouteInfo } from '@/services/api'

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

export function parseAgeSeconds(createdAt?: string | null): number {
  if (!createdAt) return 0
  const ms = new Date(createdAt).getTime()
  if (!Number.isFinite(ms)) return 0
  return Math.max(0, Math.floor((Date.now() - ms) / 1000))
}

export function formatAge(createdAt?: string | null): string {
  const sec = parseAgeSeconds(createdAt)
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export function formatHostnames(item: GRPCRouteInfo): string {
  const list = Array.isArray(item.hostnames) ? item.hostnames : []
  if (list.length === 0) return '*'
  return list.map((h) => h || '*').join(', ')
}

export function grpcRouteToRawJson(item: GRPCRouteInfo): Record<string, unknown> {
  return {
    apiVersion: item.api_version || 'gateway.networking.k8s.io/v1',
    kind: 'GRPCRoute',
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
