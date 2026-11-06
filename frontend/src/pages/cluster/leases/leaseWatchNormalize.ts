// Lease watch event → the list's row, and applying it to the list.

import type { LeaseInfo } from '@/services/api'
import { applyRowEvent } from '@/services/applyRowEvent'

export function normalizeWatchLeaseObject(obj: any): LeaseInfo {
  // a row the server could not convert keeps its spec nested, and has every name a row has at its top
  if (typeof obj?.name === 'string' && typeof obj?.namespace === 'string' && obj?.spec === undefined) {
    return obj as LeaseInfo
  }
  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    holder_identity: spec?.holderIdentity ?? obj?.holder_identity,
    lease_duration_seconds: spec?.leaseDurationSeconds ?? obj?.lease_duration_seconds,
    lease_transitions: spec?.leaseTransitions ?? obj?.lease_transitions,
    renew_time: spec?.renewTime ?? obj?.renew_time,
    acquire_time: spec?.acquireTime ?? obj?.acquire_time,
    labels: metadata?.labels ?? obj?.labels ?? {},
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
  }
}

export function applyLeaseWatchEvent(
  prev: LeaseInfo[] | undefined,
  event: { type?: string; object?: any },
): LeaseInfo[] {
  return applyRowEvent(prev, event, normalizeWatchLeaseObject)
}
