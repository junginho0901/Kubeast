// StorageClasses 페이지의 helper 함수 및 type
//
// frontend/src/pages/storage/StorageClasses.tsx 의 parseAgeSeconds /
// formatAge / storageClassToRawJson + SortKey 타입 추출. cluster-scoped.

import type { StorageClassInfo } from '@/services/api'

export type SortKey =
  | null
  | 'name'
  | 'provisioner'
  | 'default'
  | 'reclaimPolicy'
  | 'bindingMode'
  | 'allowExpansion'
  | 'age'

export { ageSeconds as parseAgeSeconds, formatAge } from '@/utils/time'

// kubectl v1.37 printStorageClassList marks one class "(default)": of the classes with a default annotation
// (is_default), the newest — the one the DefaultStorageClass admission gives a claim — and at equal times the first
// name. The list says Yes for that class alone; the drawer keeps the annotation, as kubectl describe does.
export function markEffectiveDefault(list: StorageClassInfo[] | undefined): StorageClassInfo[] | undefined {
  if (!Array.isArray(list)) return list
  let pick: StorageClassInfo | null = null
  for (const sc of list) {
    if (!sc.is_default) continue
    const at = Date.parse(sc.created_at ?? '')
    const pickAt = pick ? Date.parse(pick.created_at ?? '') : NaN
    if (!pick || at > pickAt || (at === pickAt && sc.name < pick.name)) pick = sc
  }
  return list.map((sc) => (sc.is_default && sc !== pick ? { ...sc, is_default: false } : sc))
}

export function storageClassToRawJson(sc: StorageClassInfo): Record<string, unknown> {
  const annotations: Record<string, string> = { ...(sc.annotations || {}) }

  return {
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    metadata: {
      name: sc.name,
      labels: sc.labels || {},
      annotations,
      finalizers: sc.finalizers || [],
      creationTimestamp: sc.created_at,
    },
    provisioner: sc.provisioner,
    reclaimPolicy: sc.reclaim_policy || undefined,
    volumeBindingMode: sc.volume_binding_mode || undefined,
    allowVolumeExpansion: sc.allow_volume_expansion,
    parameters: sc.parameters || {},
    mountOptions: sc.mount_options || [],
  }
}
