// LimitRanges 페이지 전용 순수 helper.
//
// LimitRanges.tsx 본체에서 분리. 본체 줄수 축소 + sort/format/raw JSON
// 변환 로직 단일 책임화. 외부 의존 없음 (LimitRangeInfo type 만 사용).

import type { LimitRangeInfo } from '@/services/api'

export type SortKey = null | 'name' | 'namespace' | 'types' | 'age'

export { ageSeconds as parseAgeSeconds, formatAge } from '@/utils/time'

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
