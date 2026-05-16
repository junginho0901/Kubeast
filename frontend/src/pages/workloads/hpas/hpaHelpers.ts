// HPAs 페이지의 helper 함수 및 type
//
// frontend/src/pages/workloads/HPAs.tsx 의 parseAgeSeconds / formatAge /
// hpaToRawJson + SortKey 타입 추출. 순수 함수 + 타입 정의.

import type { HPAInfo } from '@/services/api'

export type SortKey = null | 'name' | 'target' | 'minReplicas' | 'maxReplicas' | 'currentReplicas' | 'desiredReplicas' | 'age'

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
