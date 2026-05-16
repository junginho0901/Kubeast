// VPA watch event 정규화 + 적용 helper
//
// frontend/src/pages/workloads/VPAs.tsx 의 normalizeWatchVPAObject +
// applyVPAWatchEvent 추출. raw k8s VPA object 를 API list 형태 (VPAInfo) 로
// 정규화하고, watch event (ADDED/MODIFIED/DELETED) 를 cache 배열에 머지.

import { mergeWatchUpdate } from '@/services/mergeWatchUpdate'
import type { VPAInfo } from '@/services/api'

export function normalizeWatchVPAObject(obj: any): VPAInfo {
  if (typeof obj?.name === 'string' && typeof obj?.namespace === 'string' && 'update_mode' in obj) {
    return obj as VPAInfo
  }
  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}
  const targetRef = spec?.targetRef ?? {}
  const updatePolicy = spec?.updatePolicy ?? {}

  let cpuTarget = ''
  let memoryTarget = ''
  let provided = ''

  if (status?.conditions?.[0]?.status) {
    provided = status.conditions[0].status
  }
  const recs = status?.recommendation?.containerRecommendations
  if (Array.isArray(recs) && recs.length > 0) {
    cpuTarget = recs[0]?.target?.cpu ?? ''
    memoryTarget = recs[0]?.target?.memory ?? ''
  }

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    target_ref: `${targetRef?.kind ?? ''}/${targetRef?.name ?? ''}`,
    target_ref_kind: targetRef?.kind ?? '',
    target_ref_name: targetRef?.name ?? '',
    update_mode: updatePolicy?.updateMode ?? '',
    cpu_target: cpuTarget,
    memory_target: memoryTarget,
    provided,
    labels: metadata?.labels ?? obj?.labels,
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
  }
}

export function applyVPAWatchEvent(
  prev: VPAInfo[] | undefined,
  event: { type?: string; object?: any },
): VPAInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchVPAObject(obj)
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
