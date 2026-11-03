// ResourceClaimTemplates watch event 적용 helper
//
// 서버(k8s-service internal/drarow)가 목록과 같은 행을 보내므로 행을 통째로 바꾼다.

import type { ResourceClaimTemplateItem } from '@/services/api'

export function applyResourceClaimTemplateWatchEvent(
  prev: ResourceClaimTemplateItem[] | undefined,
  event: { type?: string; object?: any },
): ResourceClaimTemplateItem[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object as ResourceClaimTemplateItem | undefined
  const name = obj?.name
  const namespace = obj?.namespace
  if (!name || !namespace) return items

  const key = `${namespace}/${name}`
  const index = items.findIndex((item) => `${item.namespace}/${item.name}` === key)

  if (event.type === 'DELETED') {
    if (index >= 0) items.splice(index, 1)
    return items
  }

  if (index >= 0) items[index] = obj
  else items.push(obj)

  return items
}
