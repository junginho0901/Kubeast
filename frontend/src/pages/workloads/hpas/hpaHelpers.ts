// HPAs 페이지의 helper 함수 및 type
//
// frontend/src/pages/workloads/HPAs.tsx 의 parseAgeSeconds / formatAge /
// hpaToRawJson + SortKey 타입 추출. 순수 함수 + 타입 정의.

import type { HPAInfo } from '@/services/api'

export type SortKey = null | 'name' | 'target' | 'minReplicas' | 'maxReplicas' | 'currentReplicas' | 'desiredReplicas' | 'age'

export { ageSeconds as parseAgeSeconds, formatAge } from '@/utils/time'

// Without a metrics source the HPA controller reports desiredReplicas 0 while
// the target keeps running — show "-" instead of a misleading "2/0".
export function hasCurrentMetric(h: HPAInfo): boolean {
  const metrics = Array.isArray((h as any).metrics) ? ((h as any).metrics as any[]) : []
  if (metrics.length === 0) return true
  return metrics.some((m) => {
    const cur = m?.current
    return !!cur && Object.values(cur).some((v) => v !== '' && v != null)
  })
}

export function hpaToRawJson(hpa: HPAInfo): Record<string, unknown> {
  return {
    apiVersion: 'autoscaling/v2',
    kind: 'HorizontalPodAutoscaler',
    metadata: {
      name: hpa.name,
      namespace: hpa.namespace,
      creationTimestamp: hpa.created_at,
    },
    spec: {
      minReplicas: hpa.min_replicas,
      maxReplicas: hpa.max_replicas,
    },
    status: {
      currentReplicas: hpa.current_replicas,
      desiredReplicas: hpa.desired_replicas,
    },
  }
}
