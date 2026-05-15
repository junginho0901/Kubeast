// CronJobs 페이지의 순수 helper 함수 / 타입 모음
//
// frontend/src/pages/workloads/CronJobs.tsx 의 상단 helper 3개 + rawJson 빌더 + SortKey 추출.
// 모두 순수 함수 (외부 상태 의존 X). watch event 정규화는 cronJobWatchNormalize.ts.

import type { CronJobInfo } from '@/services/api'

export type SortKey =
  | null
  | 'name'
  | 'schedule'
  | 'suspend'
  | 'active'
  | 'lastSchedule'
  | 'containers'
  | 'images'
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

export function formatTimestamp(ts?: string | null): string {
  if (!ts) return '-'
  const ms = new Date(ts)
  if (!Number.isFinite(ms.getTime())) return '-'
  return ms.toLocaleString()
}

export function cronJobToWorkloadRawJson(cronjob: CronJobInfo): Record<string, unknown> {
  const labels = { app: cronjob.name }
  const containers = (cronjob.images || []).map((image, idx) => ({
    name: cronjob.containers?.[idx] || `container-${idx + 1}`,
    image,
  }))

  return {
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: {
      name: cronjob.name,
      namespace: cronjob.namespace,
      labels,
      creationTimestamp: cronjob.created_at,
    },
    spec: {
      schedule: cronjob.schedule,
      suspend: cronjob.suspend,
      concurrencyPolicy: cronjob.concurrency_policy,
      jobTemplate: {
        spec: {
          template: {
            metadata: { labels },
            spec: {
              restartPolicy: 'OnFailure',
              containers,
            },
          },
        },
      },
    },
    status: {
      lastScheduleTime: cronjob.last_schedule_time,
      lastSuccessfulTime: cronjob.last_successful_time,
      active: Array.from({ length: Number(cronjob.active || 0) }, (_, idx) => ({
        kind: 'Job',
        name: `active-${idx + 1}`,
      })),
    },
  }
}
