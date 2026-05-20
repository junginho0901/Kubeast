// VolumeAttachments watch event 정규화 + 적용 helper
//
// frontend/src/pages/storage/VolumeAttachments.tsx 의
// normalizeWatchVolumeAttachmentObject / applyVolumeAttachmentWatchEvent 추출.
// raw k8s VolumeAttachment (storage.k8s.io/v1) object 를 API list 형태
// (VolumeAttachmentInfo) 로 정규화 — normalizeError (모듈 내부 helper) 가
// attach_error / detach_error 의 {time, message} 안전 처리, time/message 둘 다
// 없으면 null. spec.source.persistentVolumeName + spec.nodeName camelCase/
// snake_case 둘 다 지원.

import { mergeWatchUpdate } from '@/services/mergeWatchUpdate'
import type { VolumeAttachmentInfo } from '@/services/api'

function normalizeError(error?: { time?: string | null; message?: string | null } | null): { time?: string | null; message?: string | null } | null {
  if (!error) return null
  const message = typeof error.message === 'string' ? error.message : null
  const time = typeof error.time === 'string' ? error.time : null
  if (!message && !time) return null
  return { message, time }
}

export function normalizeWatchVolumeAttachmentObject(obj: any): VolumeAttachmentInfo {
  if (typeof obj?.name === 'string') {
    return {
      name: obj.name,
      attacher: obj?.attacher ?? null,
      node_name: obj?.node_name ?? null,
      persistent_volume_name: obj?.persistent_volume_name ?? null,
      attached: typeof obj?.attached === 'boolean' ? obj.attached : null,
      attach_error: normalizeError(obj?.attach_error),
      detach_error: normalizeError(obj?.detach_error),
      created_at: obj?.created_at ?? null,
    }
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const source = spec?.source ?? {}
  const status = obj?.status ?? {}
  const attachError = status?.attachError ?? status?.attach_error
  const detachError = status?.detachError ?? status?.detach_error

  return {
    name: metadata?.name ?? '',
    attacher: spec?.attacher ?? null,
    node_name: spec?.nodeName ?? spec?.node_name ?? null,
    persistent_volume_name:
      source?.persistentVolumeName
      ?? source?.persistent_volume_name
      ?? null,
    attached: typeof status?.attached === 'boolean' ? status.attached : null,
    attach_error: normalizeError(attachError),
    detach_error: normalizeError(detachError),
    created_at: metadata?.creationTimestamp ?? null,
  }
}

export function applyVolumeAttachmentWatchEvent(
  prev: VolumeAttachmentInfo[] | undefined,
  event: { type?: string; object?: any },
): VolumeAttachmentInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchVolumeAttachmentObject(obj)
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
