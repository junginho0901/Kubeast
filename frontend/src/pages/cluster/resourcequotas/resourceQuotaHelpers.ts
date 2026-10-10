// ResourceQuotas 페이지 전용 순수 helper.
//
// ResourceQuotas.tsx 본체에서 분리. sort/format/raw JSON 변환 단일 책임.

import type { ResourceQuotaInfo } from '@/services/api'

export type SortKey = null | 'name' | 'namespace' | 'requests' | 'age'

export { ageSeconds as parseAgeSeconds, formatAge } from '@/utils/time'

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
