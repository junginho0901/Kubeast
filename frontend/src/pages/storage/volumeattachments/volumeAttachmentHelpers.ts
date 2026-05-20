// VolumeAttachments 페이지의 helper 함수 및 type
//
// frontend/src/pages/storage/VolumeAttachments.tsx 의 parseAgeSeconds /
// formatAge / statusLabel / statusBadgeClass / errorText / toRawJson +
// SortKey + SummaryCard tuple 타입 추출. cluster-scoped 라 namespace 없음.
// statusLabel: attach/detach error 있으면 Error → attached=true Attached →
// attached=false Detached → null Unknown.

import type { VolumeAttachmentInfo } from '@/services/api'

export type SortKey = null | 'name' | 'attacher' | 'pv' | 'node' | 'attached' | 'error' | 'age'
export type SummaryCard = [label: string, value: number, boxClass: string, labelClass: string]

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

export function statusLabel(va: VolumeAttachmentInfo): 'Attached' | 'Detached' | 'Error' | 'Unknown' {
  if (va.attach_error?.message || va.detach_error?.message) return 'Error'
  if (va.attached === true) return 'Attached'
  if (va.attached === false) return 'Detached'
  return 'Unknown'
}

export function statusBadgeClass(status: string): string {
  const lower = status.toLowerCase()
  if (lower === 'attached') return 'badge-success'
  if (lower === 'detached') return 'badge-warning'
  if (lower === 'error') return 'badge-error'
  return 'badge-info'
}

export function errorText(va: VolumeAttachmentInfo): string {
  const attachMessage = va.attach_error?.message || ''
  const detachMessage = va.detach_error?.message || ''
  if (attachMessage && detachMessage) return `${attachMessage} | ${detachMessage}`
  return attachMessage || detachMessage || '-'
}

export function volumeAttachmentToRawJson(va: VolumeAttachmentInfo): Record<string, unknown> {
  return {
    apiVersion: 'storage.k8s.io/v1',
    kind: 'VolumeAttachment',
    metadata: {
      name: va.name,
      creationTimestamp: va.created_at,
    },
    spec: {
      attacher: va.attacher,
      nodeName: va.node_name,
      source: {
        persistentVolumeName: va.persistent_volume_name,
      },
    },
    status: {
      attached: va.attached,
      attachError: va.attach_error
        ? {
            message: va.attach_error.message,
            time: va.attach_error.time,
          }
        : undefined,
      detachError: va.detach_error
        ? {
            message: va.detach_error.message,
            time: va.detach_error.time,
          }
        : undefined,
    },
  }
}
