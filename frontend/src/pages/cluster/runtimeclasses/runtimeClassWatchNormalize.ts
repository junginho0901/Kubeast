// RuntimeClass watch event → the list's row, and applying it to the list.

import type { RuntimeClassInfo } from '@/services/api'
import { applyRowEvent } from '@/services/applyRowEvent'

export function normalizeWatchRuntimeClassObject(obj: any): RuntimeClassInfo {
  if (typeof obj?.name === 'string' && typeof obj?.handler === 'string' && typeof obj?.created_at === 'string') {
    return obj as RuntimeClassInfo
  }
  const metadata = obj?.metadata ?? {}

  return {
    name: metadata?.name ?? obj?.name ?? '',
    handler: obj?.handler ?? '',
    labels: metadata?.labels ?? obj?.labels ?? {},
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
  }
}

export function applyRuntimeClassWatchEvent(
  prev: RuntimeClassInfo[] | undefined,
  event: { type?: string; object?: any },
): RuntimeClassInfo[] {
  return applyRowEvent(prev, event, normalizeWatchRuntimeClassObject)
}
