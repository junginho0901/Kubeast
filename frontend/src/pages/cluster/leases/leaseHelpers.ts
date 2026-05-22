// Leases 페이지 전용 순수 helper.
//
// Leases.tsx 본체에서 분리. sort/format/raw JSON 변환 단일 책임.

import type { LeaseInfo } from '@/services/api'

export type SortKey = null | 'name' | 'namespace' | 'holder' | 'duration' | 'age'

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
