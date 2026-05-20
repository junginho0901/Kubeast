// StorageClasses watch event 정규화 + 적용 helper
//
// frontend/src/pages/storage/StorageClasses.tsx 의
// normalizeWatchStorageClassObject / applyStorageClassWatchEvent 추출.
// raw k8s StorageClass (storage.k8s.io/v1) object 를 API list 형태
// (StorageClassInfo) 로 정규화 — **is_default 판정** = annotation
// `storageclass.kubernetes.io/is-default-class === 'true'` 또는 `.beta.
// kubernetes.io/is-default-class === 'true'` (legacy beta). reclaimPolicy /
// volumeBindingMode / allowVolumeExpansion / mountOptions camelCase/snake_case
// 둘 다 지원.

import { mergeWatchUpdate } from '@/services/mergeWatchUpdate'
import type { StorageClassInfo } from '@/services/api'

export function normalizeWatchStorageClassObject(obj: any): StorageClassInfo {
  if (typeof obj?.name === 'string' && typeof obj?.provisioner === 'string') {
    return {
      ...obj,
      parameters: obj?.parameters ?? {},
      mount_options: Array.isArray(obj?.mount_options) ? obj.mount_options : [],
      allowed_topologies: Array.isArray(obj?.allowed_topologies) ? obj.allowed_topologies : [],
    } as StorageClassInfo
  }

  const metadata = obj?.metadata ?? {}
  const annotations = (metadata?.annotations ?? {}) as Record<string, string>
  const labels = (metadata?.labels ?? {}) as Record<string, string>
  const isDefault = annotations['storageclass.kubernetes.io/is-default-class'] === 'true'
    || annotations['storageclass.beta.kubernetes.io/is-default-class'] === 'true'

  return {
    name: metadata?.name ?? obj?.name ?? '',
    provisioner: obj?.provisioner ?? '',
    reclaim_policy: obj?.reclaimPolicy ?? obj?.reclaim_policy ?? null,
    volume_binding_mode: obj?.volumeBindingMode ?? obj?.volume_binding_mode ?? null,
    allow_volume_expansion: obj?.allowVolumeExpansion ?? obj?.allow_volume_expansion ?? null,
    is_default: isDefault || Boolean(obj?.is_default),
    parameters: (obj?.parameters ?? {}) as Record<string, any>,
    mount_options: Array.isArray(obj?.mountOptions)
      ? obj.mountOptions
      : (Array.isArray(obj?.mount_options) ? obj.mount_options : []),
    allowed_topologies: Array.isArray(obj?.allowed_topologies) ? obj.allowed_topologies : [],
    labels,
    annotations,
    finalizers: Array.isArray(metadata?.finalizers) ? metadata.finalizers : [],
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
  }
}

export function applyStorageClassWatchEvent(prev: StorageClassInfo[] | undefined, event: { type?: string; object?: any }): StorageClassInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchStorageClassObject(obj)
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
