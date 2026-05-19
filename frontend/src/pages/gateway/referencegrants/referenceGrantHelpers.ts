// ReferenceGrants 페이지의 helper 함수 및 type
//
// frontend/src/pages/gateway/ReferenceGrants.tsx 의 parseAgeSeconds / formatAge /
// formatFrom / formatTo / referenceGrantToRawJson + SortKey 타입 추출.
// formatFrom 은 'kind (namespace)' 형식, formatTo 는 'kind (name)' 형식
// (name 있을 때만 괄호). Gateway API v1beta1.

import type { ReferenceGrantInfo } from '@/services/api'

export type SortKey = null | 'name' | 'namespace' | 'from' | 'to' | 'age'

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

export function formatFrom(item: ReferenceGrantInfo): string {
  const from = Array.isArray(item.from) ? item.from : []
  if (from.length === 0) return '-'
  return from.map((f) => `${f.kind || '-'} (${f.namespace || '-'})`).join(', ')
}

export function formatTo(item: ReferenceGrantInfo): string {
  const to = Array.isArray(item.to) ? item.to : []
  if (to.length === 0) return '-'
  return to.map((t) => `${t.kind || '-'}${t.name ? ` (${t.name})` : ''}`).join(', ')
}

export function referenceGrantToRawJson(item: ReferenceGrantInfo): Record<string, unknown> {
  return {
    apiVersion: item.api_version || 'gateway.networking.k8s.io/v1beta1',
    kind: 'ReferenceGrant',
    metadata: {
      name: item.name,
      namespace: item.namespace,
      labels: item.labels || {},
      annotations: item.annotations || {},
      creationTimestamp: item.created_at,
    },
    spec: {
      from: item.from || [],
      to: item.to || [],
    },
  }
}
