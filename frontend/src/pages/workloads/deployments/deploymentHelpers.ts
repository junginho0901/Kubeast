// Deployments 페이지의 순수 helper 함수 / 타입 모음
//
// frontend/src/pages/workloads/Deployments.tsx 의 상단 4 함수 + rawJson 빌더 + SortKey 추출.
// 모두 순수 함수 (외부 상태 의존 X). watch event 정규화는 deploymentWatchNormalize.ts.

import type { DeploymentInfo } from '@/services/api'

export type SortKey = null | 'name' | 'ready' | 'updated' | 'available' | 'status' | 'image' | 'age'

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

export function computeDeploymentStatus(replicas: number, readyReplicas: number): string {
  if (readyReplicas === 0) return 'Unavailable'
  if (readyReplicas !== replicas) return 'Degraded'
  return 'Healthy'
}

// status 단어 매핑: backend k8s-service-go/internal/k8s/deployments.go 는
// "Available" / "Progressing" / "Failed" 를, frontend 의 computeDeploymentStatus
// fallback 은 "Healthy" / "Degraded" / "Unavailable" 을 만들어내므로 양쪽 모두 매핑.
// "available" 은 "unavailable" 부분문자열이라 검사 순서 주의 (unavailable 먼저).
export function getDeploymentStatusColor(status: string): string {
  const lower = String(status || '').toLowerCase()
  if (lower.includes('unavailable') || lower.includes('failed')) return 'badge-error'
  if (lower.includes('healthy') || lower.includes('available')) return 'badge-success'
  if (lower.includes('degraded') || lower.includes('progress')) return 'badge-warning'
  return 'badge-info'
}

// summary 4 카드 (Total/Healthy/Degraded/Unavailable) 분류.
// getDeploymentStatusColor 와 같은 키워드 매핑 사용.
export function classifyDeploymentStatus(status: string): 'healthy' | 'degraded' | 'unavailable' {
  const lower = String(status || '').toLowerCase()
  if (lower.includes('unavailable') || lower.includes('failed')) return 'unavailable'
  if (lower.includes('healthy') || lower.includes('available')) return 'healthy'
  return 'degraded'
}

export function deploymentToWorkloadRawJson(deployment: DeploymentInfo): Record<string, unknown> {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: deployment.name,
      namespace: deployment.namespace,
      labels: deployment.labels || {},
      creationTimestamp: deployment.created_at,
    },
    spec: {
      replicas: deployment.replicas,
      selector: { matchLabels: deployment.selector || {} },
      template: {
        metadata: { labels: deployment.selector || {} },
        spec: {
          containers: deployment.image
            ? [{ name: deployment.name, image: deployment.image }]
            : [],
        },
      },
    },
    status: {
      readyReplicas: deployment.ready_replicas,
      availableReplicas: deployment.available_replicas,
      updatedReplicas: deployment.updated_replicas,
    },
  }
}
