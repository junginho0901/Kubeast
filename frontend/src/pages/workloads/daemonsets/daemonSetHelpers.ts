// DaemonSets 페이지의 순수 helper 함수 / 타입 모음
//
// frontend/src/pages/workloads/DaemonSets.tsx 의 상단 4 함수 + rawJson 빌더 + SortKey 추출.
// 모두 순수 함수 (외부 상태 의존 X). watch event 정규화는 daemonSetWatchNormalize.ts.

import type { DaemonSetInfo } from '@/services/api'

export type SortKey = null | 'name' | 'ready' | 'current' | 'desired' | 'updated' | 'available' | 'status' | 'images' | 'age'

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

export function computeDaemonSetStatus(daemonset: {
  desired: number
  ready: number
  misscheduled?: number
  unavailable?: number
}): string {
  const desired = daemonset.desired || 0
  const ready = daemonset.ready || 0
  const misscheduled = daemonset.misscheduled || 0
  const unavailable = daemonset.unavailable || 0

  if (desired === 0) return 'Idle'
  if (ready === 0) return 'Unavailable'
  if (ready !== desired || misscheduled > 0 || unavailable > 0) return 'Degraded'
  return 'Healthy'
}

export function getDaemonSetStatusColor(status: string): string {
  const lower = String(status || '').toLowerCase()
  if (lower.includes('healthy')) return 'badge-success'
  if (lower.includes('degraded') || lower.includes('idle')) return 'badge-warning'
  if (lower.includes('unavailable') || lower.includes('error') || lower.includes('failed')) return 'badge-error'
  return 'badge-info'
}

export function daemonSetToWorkloadRawJson(daemonset: DaemonSetInfo): Record<string, unknown> {
  return {
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: {
      name: daemonset.name,
      namespace: daemonset.namespace,
      creationTimestamp: daemonset.created_at,
    },
    spec: {
      selector: { matchLabels: { app: daemonset.name } },
      template: {
        metadata: { labels: { app: daemonset.name } },
        spec: {
          nodeSelector: daemonset.node_selector || {},
          containers: (daemonset.images || []).map((image, idx) => ({
            name: `container-${idx + 1}`,
            image,
          })),
        },
      },
      updateStrategy: {
        type: 'RollingUpdate',
      },
    },
    status: {
      desiredNumberScheduled: daemonset.desired,
      currentNumberScheduled: daemonset.current,
      numberReady: daemonset.ready,
      updatedNumberScheduled: daemonset.updated,
      numberAvailable: daemonset.available,
      numberMisscheduled: daemonset.misscheduled,
      numberUnavailable: daemonset.unavailable,
    },
  }
}
