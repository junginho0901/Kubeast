// HPA watch event 정규화 + 적용 helper
//
// frontend/src/pages/workloads/HPAs.tsx 의 normalizeWatchHPAObject +
// applyHPAWatchEvent 추출. raw k8s HPA object 를 API list 형태 (HPAInfo) 로
// 정규화하고, watch event (ADDED/MODIFIED/DELETED) 를 cache 배열에 머지.

import { mergeWatchUpdate } from '@/services/mergeWatchUpdate'
import type { HPAInfo } from '@/services/api'

export function normalizeWatchHPAObject(obj: any): HPAInfo {
  if (typeof obj?.name === 'string' && typeof obj?.namespace === 'string' && typeof obj?.max_replicas === 'number') {
    return obj as HPAInfo
  }
  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}
  const scaleTargetRef = spec?.scaleTargetRef ?? {}

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    target_ref: `${scaleTargetRef?.kind ?? ''}/${scaleTargetRef?.name ?? ''}`,
    min_replicas: spec?.minReplicas ?? null,
    max_replicas: spec?.maxReplicas ?? 0,
    current_replicas: status?.currentReplicas ?? null,
    desired_replicas: status?.desiredReplicas ?? null,
    metrics: [],
    conditions: [],
    last_scale_time: status?.lastScaleTime ?? null,
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
  }
}

export function applyHPAWatchEvent(
  prev: HPAInfo[] | undefined,
  event: { type?: string; object?: any },
): HPAInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchHPAObject(obj)
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
