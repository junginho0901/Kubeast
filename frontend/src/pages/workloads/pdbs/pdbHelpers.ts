// PDBs 페이지의 helper 함수 및 type
//
// frontend/src/pages/workloads/PDBs.tsx 의 parseAgeSeconds / formatAge /
// pdbToRawJson + SortKey 타입 추출. 순수 함수 + 타입 정의.

import type { PDBInfo } from '@/services/api'

export type SortKey = null | 'name' | 'minAvailable' | 'maxUnavailable' | 'allowedDisruptions' | 'currentHealthy' | 'desiredHealthy' | 'age'

export { ageSeconds as parseAgeSeconds, formatAge } from '@/utils/time'

export function pdbToRawJson(pdb: PDBInfo): Record<string, unknown> {
  const spec: Record<string, unknown> = {}
  if (pdb.min_available != null) spec.minAvailable = pdb.min_available
  if (pdb.max_unavailable != null) spec.maxUnavailable = pdb.max_unavailable
  if (pdb.selector && Object.keys(pdb.selector).length > 0) {
    spec.selector = { matchLabels: pdb.selector }
  }

  return {
    apiVersion: 'policy/v1',
    kind: 'PodDisruptionBudget',
    metadata: {
      name: pdb.name,
      namespace: pdb.namespace,
      creationTimestamp: pdb.created_at,
    },
    spec,
    status: {
      currentHealthy: pdb.current_healthy,
      desiredHealthy: pdb.desired_healthy,
      disruptionsAllowed: pdb.disruptions_allowed,
      expectedPods: pdb.expected_pods,
    },
  }
}
