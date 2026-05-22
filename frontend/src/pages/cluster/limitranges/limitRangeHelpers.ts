// LimitRanges 페이지 전용 순수 helper.
//
// LimitRanges.tsx 본체에서 분리. 본체 줄수 축소 + sort/format/raw JSON
// 변환 로직 단일 책임화. 외부 의존 없음 (LimitRangeInfo type 만 사용).

import type { LimitRangeInfo } from '@/services/api'

export type SortKey = null | 'name' | 'namespace' | 'types' | 'age'

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

export function getLimitTypes(lr: LimitRangeInfo): string {
  if (!Array.isArray(lr.limits) || lr.limits.length === 0) return '-'
  const types = [...new Set(lr.limits.map((l) => l.type).filter(Boolean))]
  return types.length > 0 ? types.join(', ') : '-'
}

export function limitRangeToRawJson(lr: LimitRangeInfo): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'LimitRange',
    metadata: {
      name: lr.name,
      namespace: lr.namespace,
      labels: lr.labels || {},
      creationTimestamp: lr.created_at,
    },
    spec: {
      limits: (lr.limits || []).map((l) => ({
        type: l.type,
        default: l.default,
        defaultRequest: l.default_request,
        max: l.max,
        min: l.min,
      })),
    },
  }
}
