// Leases 페이지 전용 watch event 정규화.
//
// Leases.tsx 본체에서 분리. raw k8s coordination.k8s.io/v1 object 와
// backend API list 형태를 LeaseInfo 로 통일.

import type { LeaseInfo } from '@/services/api'
import { mergeWatchUpdate } from '@/services/mergeWatchUpdate'

export function normalizeWatchLeaseObject(obj: any): LeaseInfo {
  if (typeof obj?.name === 'string' && typeof obj?.namespace === 'string' && typeof obj?.created_at === 'string') {
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
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchLeaseObject(obj)
  const name = normalized?.name
  const namespace = normalized?.namespace
  if (!name || !namespace) return items

  const key = `${namespace}/${name}`
  const index = items.findIndex((item) => `${item.namespace}/${item.name}` === key)

  if (event.type === 'DELETED') {
    if (index >= 0) items.splice(index, 1)
    return items
  }

  if (index >= 0) items[index] = mergeWatchUpdate(items[index], normalized)
  else items.push(normalized)

  return items
}
