// ResourceClaimTemplates watch event 정규화 + 적용 helper
//
// frontend/src/pages/gpu/ResourceClaimTemplates.tsx 의
// normalizeWatchResourceClaimTemplateObject /
// applyResourceClaimTemplateWatchEvent 추출.
// raw k8s ResourceClaimTemplate (resource.k8s.io/v1beta1) object 를 API
// list 형태 (ResourceClaimTemplateItem) 로 정규화 — Template 은 status 없이
// **spec.spec.devices.requests** 만 (한번 더 wrap). request_count 는 그 배열
// 길이.

import { mergeWatchUpdate } from '@/services/mergeWatchUpdate'
import type { ResourceClaimTemplateItem } from '@/services/api'

export function normalizeWatchResourceClaimTemplateObject(obj: any): ResourceClaimTemplateItem {
  if (
    typeof obj?.name === 'string'
    && typeof obj?.namespace === 'string'
    && Object.prototype.hasOwnProperty.call(obj, 'request_count')
  ) {
    return {
      ...obj,
      labels: obj.labels || {},
    } as ResourceClaimTemplateItem
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec?.spec ?? {}

  const requests = Array.isArray(spec?.devices?.requests) ? spec.devices.requests : []

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    labels: metadata?.labels ?? obj?.labels ?? {},
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
    request_count: requests.length,
  }
}

export function applyResourceClaimTemplateWatchEvent(
  prev: ResourceClaimTemplateItem[] | undefined,
  event: { type?: string; object?: any },
): ResourceClaimTemplateItem[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchResourceClaimTemplateObject(obj)
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
