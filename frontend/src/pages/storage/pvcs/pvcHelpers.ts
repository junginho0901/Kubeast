// PersistentVolumeClaims 페이지의 helper 함수 및 type
//
// frontend/src/pages/storage/PersistentVolumeClaims.tsx 의 parseAgeSeconds /
// formatAge / parseQuantityToBytes / pvcToRawJson + SortKey 타입 추출.
// parseQuantityToBytes 는 Ki/Mi/Gi/Ti/Pi/Ei (binary 1024) + K/M/G/T/P/E (decimal 1000)
// 단위 환산 (정렬용).

import type { PVCInfo } from '@/services/api'

export type SortKey =
  | null
  | 'namespace'
  | 'name'
  | 'status'
  | 'storageClass'
  | 'volume'
  | 'requested'
  | 'capacity'
  | 'accessModes'
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

export function parseQuantityToBytes(value?: string | null): number | null {
  if (!value) return null
  const s = String(value).trim()
  if (!s) return null
  const m = s.match(/^([0-9]+(?:\.[0-9]+)?)([a-zA-Z]+)?$/)
  if (!m) return null

  const num = Number(m[1])
  if (Number.isNaN(num)) return null
  const unit = (m[2] || '').trim()

  const bin: Record<string, number> = {
    Ki: 1024 ** 1,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
    Ei: 1024 ** 6,
  }
  const dec: Record<string, number> = {
    K: 1000 ** 1,
    M: 1000 ** 2,
    G: 1000 ** 3,
    T: 1000 ** 4,
    P: 1000 ** 5,
    E: 1000 ** 6,
  }

  if (!unit) return num
  if (bin[unit] !== undefined) return num * bin[unit]
  if (dec[unit] !== undefined) return num * dec[unit]
  return null
}

export function pvcToRawJson(pvc: PVCInfo): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: pvc.name,
      namespace: pvc.namespace,
      creationTimestamp: pvc.created_at,
    },
    spec: {
      accessModes: pvc.access_modes || [],
      storageClassName: pvc.storage_class,
      volumeName: pvc.volume_name,
      resources: {
        requests: {
          storage: pvc.requested,
        },
      },
    },
    status: {
      phase: pvc.status,
      capacity: {
        storage: pvc.capacity,
      },
    },
  }
}
