// ReferenceGrants 페이지의 helper 함수 및 type
//
// frontend/src/pages/gateway/ReferenceGrants.tsx 의 parseAgeSeconds / formatAge /
// formatFrom / formatTo / referenceGrantToRawJson + SortKey 타입 추출.
// formatFrom 은 'kind (namespace)' 형식, formatTo 는 'kind (name)' 형식
// (name 있을 때만 괄호). Gateway API v1beta1.

import type { ReferenceGrantInfo } from '@/services/api'

export type SortKey = null | 'name' | 'namespace' | 'from' | 'to' | 'age'

export { ageSeconds as parseAgeSeconds, formatAge } from '@/utils/time'

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
