// LimitRanges 페이지 전용 watch event 정규화.
//
// LimitRanges.tsx 본체에서 분리. raw k8s object (camelCase) 와
// backend API list 형태 (snake_case) 모두를 LimitRangeInfo 로 통일.

import type { LimitRangeInfo } from '@/services/api'
import { mergeWatchUpdate } from '@/services/mergeWatchUpdate'

export function normalizeWatchLimitRangeObject(obj: any): LimitRangeInfo {
  if (typeof obj?.name === 'string' && typeof obj?.namespace === 'string' && typeof obj?.created_at === 'string') {
    return obj as LimitRangeInfo
  }
  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}

  const rawLimits: any[] = spec?.limits ?? obj?.limits ?? []
  const limits = rawLimits.map((l: any) => ({
    type: l?.type,
    default: l?.default,
    default_request: l?.defaultRequest ?? l?.default_request,
    max: l?.max,
    min: l?.min,
  }))

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    limits,
    labels: metadata?.labels ?? obj?.labels ?? {},
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
  }
}

export function applyLimitRangeWatchEvent(
  prev: LimitRangeInfo[] | undefined,
  event: { type?: string; object?: any },
): LimitRangeInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchLimitRangeObject(obj)
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
