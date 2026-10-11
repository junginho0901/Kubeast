// VPAs 페이지의 helper 함수 및 type
//
// frontend/src/pages/workloads/VPAs.tsx 의 parseAgeSeconds / formatAge /
// vpaToRawJson + SortKey 타입 추출. 순수 함수 + 타입 정의.

import type { VPAInfo } from '@/services/api'

export type SortKey = null | 'name' | 'target' | 'updateMode' | 'cpu' | 'memory' | 'provided' | 'age'

export { ageSeconds as parseAgeSeconds, formatAge } from '@/utils/time'

export function vpaToRawJson(vpa: VPAInfo): Record<string, unknown> {
  return {
    apiVersion: 'autoscaling.k8s.io/v1',
    kind: 'VerticalPodAutoscaler',
    metadata: {
      name: vpa.name,
      namespace: vpa.namespace,
      labels: vpa.labels || {},
      creationTimestamp: vpa.created_at,
    },
    spec: {
      targetRef: {
        kind: vpa.target_ref_kind,
        name: vpa.target_ref_name,
      },
      updatePolicy: {
        updateMode: vpa.update_mode,
      },
    },
  }
}
