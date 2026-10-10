// Leases 페이지 전용 순수 helper.
//
// Leases.tsx 본체에서 분리. sort/format/raw JSON 변환 단일 책임.

import type { LeaseInfo } from '@/services/api'

export type SortKey = null | 'name' | 'namespace' | 'holder' | 'duration' | 'age'

export { ageSeconds as parseAgeSeconds, formatAge } from '@/utils/time'

export function leaseToRawJson(lease: LeaseInfo): Record<string, unknown> {
  return {
    apiVersion: 'coordination.k8s.io/v1',
    kind: 'Lease',
    metadata: {
      name: lease.name,
      namespace: lease.namespace,
      labels: lease.labels || {},
      creationTimestamp: lease.created_at,
    },
    spec: {
      holderIdentity: lease.holder_identity,
      leaseDurationSeconds: lease.lease_duration_seconds,
      leaseTransitions: lease.lease_transitions,
      renewTime: lease.renew_time,
      acquireTime: lease.acquire_time,
    },
  }
}
