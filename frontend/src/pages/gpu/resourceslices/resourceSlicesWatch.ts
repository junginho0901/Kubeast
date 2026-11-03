// ResourceSlices watch event 적용 helper
//
// 서버(k8s-service internal/drarow)가 목록과 같은 행(v1 spec.nodeName·spec.driver·spec.pool)을 보내므로
// 행을 통째로 바꾼다.

import type { ResourceSliceItem } from '@/services/api'

export function applyResourceSliceWatchEvent(
  prev: ResourceSliceItem[] | undefined,
  event: { type?: string; object?: any },
): ResourceSliceItem[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object as ResourceSliceItem | undefined
  const name = obj?.name
  if (!name) return items

  const index = items.findIndex((item) => item.name === name)

  if (event.type === 'DELETED') {
    if (index >= 0) items.splice(index, 1)
    return items
  }

  if (index >= 0) items[index] = obj
  else items.push(obj)

  return items
}
