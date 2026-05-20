// PersistentVolumes watch event 정규화 + 적용 helper
//
// frontend/src/pages/storage/PersistentVolumes.tsx 의
// normalizeWatchPvObject / applyPvWatchEvent 추출.
// raw k8s PV object 를 API list 형태 (PVInfo) 로 정규화 — status.phase →
// status, spec.capacity.storage + spec.accessModes + spec.storageClassName +
// spec.persistentVolumeReclaimPolicy (default 'Delete') + spec.claimRef
// {namespace, name} + spec.volumeMode 정규화.

import { mergeWatchUpdate } from '@/services/mergeWatchUpdate'
import type { PVInfo } from '@/services/api'

export function normalizeWatchPvObject(obj: any): PVInfo {
  if (typeof obj?.name === 'string' && typeof obj?.status === 'string') {
    return {
      ...obj,
      access_modes: Array.isArray(obj?.access_modes) ? obj.access_modes : [],
    } as PVInfo
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}

  return {
    name: metadata?.name ?? obj?.name ?? '',
    status: status?.phase ?? obj?.status ?? 'Unknown',
    capacity: String(spec?.capacity?.storage ?? obj?.capacity ?? ''),
    access_modes: Array.isArray(spec?.accessModes) ? spec.accessModes : (Array.isArray(obj?.access_modes) ? obj.access_modes : []),
    storage_class: spec?.storageClassName ?? obj?.storage_class ?? null,
    reclaim_policy: spec?.persistentVolumeReclaimPolicy ?? obj?.reclaim_policy ?? 'Delete',
    claim_ref: spec?.claimRef
      ? {
          namespace: spec.claimRef.namespace,
          name: spec.claimRef.name,
        }
      : (obj?.claim_ref ?? null),
    volume_mode: spec?.volumeMode ?? obj?.volume_mode ?? null,
    source: obj?.source ?? null,
    driver: obj?.driver ?? null,
    volume_handle: obj?.volume_handle ?? null,
    node_affinity: obj?.node_affinity ?? null,
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
  }
}

export function applyPvWatchEvent(prev: PVInfo[] | undefined, event: { type?: string; object?: any }): PVInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchPvObject(obj)
  const name = normalized?.name
  if (!name) return items

  const index = items.findIndex((item) => item.name === name)

  if (event.type === 'DELETED') {
    if (index >= 0) items.splice(index, 1)
    return items
  }

  if (index >= 0) items[index] = mergeWatchUpdate(items[index], normalized)
  else items.push(normalized)
  return items
}
