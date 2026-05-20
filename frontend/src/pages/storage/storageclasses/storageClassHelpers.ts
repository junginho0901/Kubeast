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

export function storageClassToRawJson(sc: StorageClassInfo): Record<string, unknown> {
  const annotations: Record<string, string> = { ...(sc.annotations || {}) }
  if (sc.is_default) {
    annotations['storageclass.kubernetes.io/is-default-class'] = 'true'
  }

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
