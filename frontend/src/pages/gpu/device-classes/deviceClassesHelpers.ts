import { mergeWatchUpdate } from '@/services/mergeWatchUpdate'
import type { DeviceClassItem } from '@/services/api'

export type SortKey = null | 'name' | 'selectors' | 'conditions' | 'age'

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

export function formatConditions(conditions?: Array<Record<string, any>>): string {
  if (!Array.isArray(conditions) || conditions.length === 0) return '-'
  return conditions
    .map((c) => {
      const type = String(c?.type || 'Unknown')
      const status = String(c?.status || '').toLowerCase()
      return status === 'true' ? type : `${type}(${String(c?.status || 'Unknown')})`
    })
    .join(', ')
}

export function normalizeWatchDeviceClassObject(obj: any): DeviceClassItem {
  if (
    typeof obj?.name === 'string'
    && Object.prototype.hasOwnProperty.call(obj, 'selector_count')
  ) {
    return {
      ...obj,
      labels: obj.labels || {},
      conditions: Array.isArray(obj.conditions) ? obj.conditions : [],
    } as DeviceClassItem
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}
  const conditions = Array.isArray(status?.conditions) ? status.conditions : []
  const selectors = Array.isArray(spec?.selectors) ? spec.selectors : []

  return {
    name: metadata?.name ?? obj?.name ?? '',
    labels: metadata?.labels ?? obj?.labels ?? {},
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
    selector_count: selectors.length ?? obj?.selector_count ?? 0,
    conditions,
  }
}

export function applyDeviceClassWatchEvent(
  prev: DeviceClassItem[] | undefined,
  event: { type?: string; object?: any },
): DeviceClassItem[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchDeviceClassObject(obj)
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

export function deviceClassToRawJson(item: DeviceClassItem): Record<string, unknown> {
  return {
    apiVersion: 'resource.k8s.io/v1beta1',
    kind: 'DeviceClass',
    metadata: {
      name: item.name,
      labels: item.labels || {},
      creationTimestamp: item.created_at,
    },
    spec: {
      selectors: item.selector_count != null ? `(${item.selector_count} selectors)` : undefined,
    },
    status: {
      conditions: item.conditions || [],
    },
  }
}
