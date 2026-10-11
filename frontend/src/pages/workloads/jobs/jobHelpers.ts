// Jobs 페이지의 순수 helper 함수 / 타입 모음
//
// frontend/src/pages/workloads/Jobs.tsx 의 상단 helper 6개 + rawJson 빌더 + SortKey 추출.
// 모두 순수 함수 (외부 상태 의존 X). watch event 정규화는 jobWatchNormalize.ts.

import type { JobInfo } from '@/services/api'

export type SortKey =
  | null
  | 'name'
  | 'completions'
  | 'status'
  | 'duration'
  | 'containers'
  | 'images'
  | 'age'

import { humanDuration } from '@/utils/time'

export { ageSeconds as parseAgeSeconds, formatAge } from '@/utils/time'

/** A Job's run time as kubectl prints DURATION (HumanDuration). */
export function formatDuration(durationSeconds?: number | null): string {
  if (durationSeconds == null || durationSeconds < 0) return '-'
  return humanDuration(durationSeconds)
}

// backend workloads_job.go 는 condition 기반으로 "Active" / "Complete" / "Failed" 를
// 보내는데, watch event 의 raw object 는 status 가 비어있어 active/succeeded/failed
// 카운터로 추정해야 함. summary 분류 (running 카드에 Active 매칭) 도 이 status
// 문자열을 사용 — Pods.tsx 의 pickPodDisplayStatus 와 유사 패턴.
export function computeJobStatus(job: {
  status?: string
  active?: number
  failed?: number
  succeeded?: number
}): string {
  const explicit = String(job.status || '')
  if (explicit) return explicit
  if ((job.failed || 0) > 0) return 'Failed'
  if ((job.succeeded || 0) > 0) return 'Complete'
  if ((job.active || 0) > 0) return 'Running'
  return 'Pending'
}

export function getJobStatusColor(status: string): string {
  const lower = String(status || '').toLowerCase()
  if (lower.includes('complete') || lower.includes('succeeded')) return 'badge-success'
  if (lower.includes('running') || lower.includes('pending') || lower.includes('suspend')) return 'badge-warning'
  if (lower.includes('fail') || lower.includes('error')) return 'badge-error'
  return 'badge-info'
}

export function jobToWorkloadRawJson(job: JobInfo): Record<string, unknown> {
  const labels = { app: job.name }
  const containers = (job.images || []).map((image, idx) => ({
    name: job.containers?.[idx] || `container-${idx + 1}`,
    image,
  }))

  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: job.name,
      namespace: job.namespace,
      labels,
      creationTimestamp: job.created_at,
    },
    spec: {
      completions: job.completions,
      parallelism: job.parallelism,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          containers,
        },
      },
    },
    status: {
      active: job.active,
      succeeded: job.succeeded,
      failed: job.failed,
      startTime: job.start_time,
      completionTime: job.completion_time,
    },
  }
}
