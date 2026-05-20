// PersistentVolumeClaims watch event 정규화 + 적용 helper
//
// frontend/src/pages/storage/PersistentVolumeClaims.tsx 의
// normalizeWatchPvcObject / applyPvcWatchEvent 추출.
// raw k8s PVC object 를 API list 형태 (PVCInfo) 로 정규화 — status.phase →
// status, spec.volumeName + spec.storageClassName + spec.accessModes +
// status.capacity.storage + spec.resources.requests.storage 정규화.

import { mergeWatchUpdate } from '@/services/mergeWatchUpdate'
import type { PVCInfo } from '@/services/api'

export function normalizeWatchPvcObject(obj: any): PVCInfo {
  if (typeof obj?.name === 'string' && typeof obj?.namespace === 'string' && typeof obj?.status === 'string') {
    return {
      ...obj,
      access_modes: Array.isArray(obj?.access_modes) ? obj.access_modes : [],
    } as PVCInfo
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}
  const capacity = status?.capacity?.storage
  const requested = spec?.resources?.requests?.storage

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    status: status?.phase ?? obj?.status ?? 'Unknown',
    volume_name: spec?.volumeName ?? obj?.volume_name ?? null,
    storage_class: spec?.storageClassName ?? obj?.storage_class ?? null,
    capacity: capacity != null ? String(capacity) : (obj?.capacity ?? null),
    requested: requested != null ? String(requested) : (obj?.requested ?? null),
    access_modes: Array.isArray(spec?.accessModes) ? spec.accessModes : (Array.isArray(obj?.access_modes) ? obj.access_modes : []),
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
  }
}

export function applyPvcWatchEvent(prev: PVCInfo[] | undefined, event: { type?: string; object?: any }): PVCInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchPvcObject(obj)
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
