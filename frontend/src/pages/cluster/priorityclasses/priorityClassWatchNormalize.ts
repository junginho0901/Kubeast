// PriorityClass watch event → the list's row, and applying it to the list.

import type { PriorityClassInfo } from '@/services/api'
import { applyRowEvent } from '@/services/applyRowEvent'

export function normalizeWatchPriorityClassObject(obj: any): PriorityClassInfo {
  if (typeof obj?.name === 'string' && typeof obj?.value === 'number' && typeof obj?.preemption_policy === 'string') {
    return obj as PriorityClassInfo
  }
  const metadata = obj?.metadata ?? {}

  return {
    name: metadata?.name ?? obj?.name ?? '',
    value: obj?.value ?? 0,
    global_default: obj?.globalDefault === true,
    preemption_policy: obj?.preemptionPolicy ?? 'PreemptLowerPriority',
    description: obj?.description ?? '',
    labels: metadata?.labels ?? obj?.labels ?? {},
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
  }
}

export function applyPriorityClassWatchEvent(
  prev: PriorityClassInfo[] | undefined,
  event: { type?: string; object?: any },
): PriorityClassInfo[] {
  return applyRowEvent(prev, event, normalizeWatchPriorityClassObject)
}
