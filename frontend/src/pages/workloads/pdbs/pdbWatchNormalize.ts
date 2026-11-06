// PodDisruptionBudget watch event → the list's row, and applying it to the list.

import type { PDBInfo } from '@/services/api'
import { applyRowEvent } from '@/services/applyRowEvent'

export function normalizeWatchPDBObject(obj: any): PDBInfo {
  if (typeof obj?.name === 'string' && typeof obj?.namespace === 'string' && typeof obj?.current_healthy === 'number') {
    return obj as PDBInfo
  }
  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    min_available: spec?.minAvailable != null ? String(spec.minAvailable) : null,
    max_unavailable: spec?.maxUnavailable != null ? String(spec.maxUnavailable) : null,
    current_healthy: status?.currentHealthy ?? 0,
    desired_healthy: status?.desiredHealthy ?? 0,
    disruptions_allowed: status?.disruptionsAllowed ?? 0,
    expected_pods: status?.expectedPods ?? 0,
    selector: spec?.selector?.matchLabels ?? {},
    labels: metadata?.labels ?? obj?.labels ?? {},
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
  }
}

export function applyPDBWatchEvent(
  prev: PDBInfo[] | undefined,
  event: { type?: string; object?: any },
): PDBInfo[] {
  return applyRowEvent(prev, event, normalizeWatchPDBObject)
}
