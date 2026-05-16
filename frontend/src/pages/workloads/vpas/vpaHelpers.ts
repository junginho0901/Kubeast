// VPAs 페이지의 helper 함수 및 type
//
// frontend/src/pages/workloads/VPAs.tsx 의 parseAgeSeconds / formatAge /
// vpaToRawJson + SortKey 타입 추출. 순수 함수 + 타입 정의.

import type { VPAInfo } from '@/services/api'

export type SortKey = null | 'name' | 'target' | 'updateMode' | 'cpu' | 'memory' | 'provided' | 'age'

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
