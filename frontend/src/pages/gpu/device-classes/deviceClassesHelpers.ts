import type { DeviceClassItem } from '@/services/api'

export type SortKey = null | 'name' | 'selectors' | 'age'

export { ageSeconds as parseAgeSeconds, formatAge } from '@/utils/time'

export function applyDeviceClassWatchEvent(
  prev: DeviceClassItem[] | undefined,
  event: { type?: string; object?: any },
): DeviceClassItem[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object as DeviceClassItem | undefined
  const name = obj?.name
  if (!name) return items

  const index = items.findIndex((item) => item.name === name)

  if (event.type === 'DELETED') {
    if (index >= 0) items.splice(index, 1)
    return items
  }

  // the server sends the whole row (internal/drarow), so it replaces
  if (index >= 0) items[index] = obj
  else items.push(obj)

  return items
}

export function deviceClassToRawJson(item: DeviceClassItem): Record<string, unknown> {
  return {
    apiVersion: 'resource.k8s.io/v1',
    kind: 'DeviceClass',
    metadata: {
      name: item.name,
      labels: item.labels || {},
      creationTimestamp: item.created_at,
    },
  }
}
