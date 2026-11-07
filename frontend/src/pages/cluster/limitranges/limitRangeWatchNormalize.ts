// LimitRange watch event → the list's row, and applying it to the list.

import type { LimitRangeInfo } from '@/services/api'
import { applyRowEvent } from '@/services/applyRowEvent'

export function normalizeWatchLimitRangeObject(obj: any): LimitRangeInfo {
  if (typeof obj?.name === 'string' && typeof obj?.namespace === 'string' && Array.isArray(obj?.limits)) {
    return obj as LimitRangeInfo
  }
  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}

  const rawLimits: any[] = Array.isArray(spec?.limits) ? spec.limits : []
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
  return applyRowEvent(prev, event, normalizeWatchLimitRangeObject)
}
