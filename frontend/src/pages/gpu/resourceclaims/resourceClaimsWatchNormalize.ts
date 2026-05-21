// ResourceClaims watch event 정규화 + 적용 helper
//
// frontend/src/pages/gpu/ResourceClaims.tsx 의
// normalizeWatchResourceClaimObject / applyResourceClaimWatchEvent 추출.
// raw k8s ResourceClaim (resource.k8s.io/v1beta1) object 를 API list 형태
// (ResourceClaimItem) 로 정규화 — **allocation_status 판정** = status.allocation
// 존재 시 'Allocated', status.reservedFor 존재 시 'Reserved', 그 외 null
// (= UI 에서 Pending 으로 표기). request_count 는 spec.devices.requests 배열
// 길이.

import { mergeWatchUpdate } from '@/services/mergeWatchUpdate'
import type { ResourceClaimItem } from '@/services/api'

export function normalizeWatchResourceClaimObject(obj: any): ResourceClaimItem {
  if (
    typeof obj?.name === 'string'
    && typeof obj?.namespace === 'string'
    && Object.prototype.hasOwnProperty.call(obj, 'request_count')
  ) {
    return {
      ...obj,
      labels: obj.labels || {},
    } as ResourceClaimItem
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}

  const requests = Array.isArray(spec?.devices?.requests) ? spec.devices.requests : []
  const allocationStatus = status?.allocation ? 'Allocated' : (status?.reservedFor ? 'Reserved' : null)

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    labels: metadata?.labels ?? obj?.labels ?? {},
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
    request_count: requests.length,
    allocation_status: allocationStatus,
  }
}

export function applyResourceClaimWatchEvent(
  prev: ResourceClaimItem[] | undefined,
  event: { type?: string; object?: any },
): ResourceClaimItem[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchResourceClaimObject(obj)
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
