// ReplicaSets 페이지의 순수 helper 함수 / 타입 모음
//
// frontend/src/pages/workloads/ReplicaSets.tsx 의 상단 4 함수 + rawJson 빌더 + SortKey 추출.
// 모두 순수 함수 (외부 상태 의존 X). watch event 정규화는 replicaSetWatchNormalize.ts.

import type { ReplicaSetInfo } from '@/services/api'

export type SortKey =
  | null
  | 'name'
  | 'current'
  | 'desired'
  | 'ready'
  | 'available'
  | 'status'
  | 'containers'
  | 'images'
  | 'selector'
  | 'age'

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

export function computeReplicaSetStatus(rs: {
  replicas: number
  ready_replicas: number
}): string {
  const desired = rs.replicas || 0
  const ready = rs.ready_replicas || 0
  if (desired === 0 && ready === 0) return 'Idle'
  if (desired > 0 && ready === 0) return 'Unavailable'
  if (ready !== desired) return 'Degraded'
  return 'Healthy'
}

export function getReplicaSetStatusColor(status: string): string {
  const lower = String(status || '').toLowerCase()
  if (lower.includes('healthy')) return 'badge-success'
  if (lower.includes('degraded') || lower.includes('idle')) return 'badge-warning'
  if (lower.includes('unavailable') || lower.includes('error') || lower.includes('failed')) return 'badge-error'
  return 'badge-info'
}

export function replicaSetToWorkloadRawJson(replicaset: ReplicaSetInfo): Record<string, unknown> {
  const labels = replicaset.selector || { app: replicaset.name }
  const containers = (replicaset.images || []).map((image, idx) => ({
    name: replicaset.container_names?.[idx] || `container-${idx + 1}`,
    image,
  }))

  return {
    apiVersion: 'apps/v1',
    kind: 'ReplicaSet',
    metadata: {
      name: replicaset.name,
      namespace: replicaset.namespace,
      labels: replicaset.labels || {},
      creationTimestamp: replicaset.created_at,
    },
    spec: {
      replicas: replicaset.replicas,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: { containers },
      },
    },
    status: {
      replicas: replicaset.current_replicas,
      readyReplicas: replicaset.ready_replicas,
      availableReplicas: replicaset.available_replicas,
    },
  }
}
