// ResourceQuotas 페이지 전용 순수 helper.
//
// ResourceQuotas.tsx 본체에서 분리. sort/format/raw JSON 변환 단일 책임.

import type { ResourceQuotaInfo } from '@/services/api'

export type SortKey = null | 'name' | 'namespace' | 'requests' | 'age'

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

export function resourceQuotaToRawJson(rq: ResourceQuotaInfo): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'ResourceQuota',
    metadata: {
      name: rq.name,
      namespace: rq.namespace,
      labels: rq.labels || {},
      creationTimestamp: rq.created_at,
    },
    status: {
      hard: rq.status_hard,
      used: rq.status_used,
    },
  }
}
