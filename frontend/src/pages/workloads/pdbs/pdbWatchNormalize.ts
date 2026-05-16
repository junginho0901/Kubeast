// PDB watch event 정규화 + 적용 helper
//
// frontend/src/pages/workloads/PDBs.tsx 의 normalizeWatchPDBObject +
// applyPDBWatchEvent 추출. raw k8s PDB object 를 API list 형태 (PDBInfo) 로
// 정규화하고, watch event (ADDED/MODIFIED/DELETED) 를 cache 배열에 머지.

import { mergeWatchUpdate } from '@/services/mergeWatchUpdate'
import type { PDBInfo } from '@/services/api'

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
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
  }
}

export function applyPDBWatchEvent(
  prev: PDBInfo[] | undefined,
  event: { type?: string; object?: any },
): PDBInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchPDBObject(obj)
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
