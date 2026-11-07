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

/**
 * A Job's run time in seconds as kubectl's printJob computes DURATION: start to completion, or start to now while
 * it has no completion time (running, or failed — a failed Job never gets one).
 */
export function jobDurationSeconds(job: { start_time?: string | null; completion_time?: string | null }, now = Date.now()): number | null {
  if (!job.start_time) return null
  const start = new Date(job.start_time).getTime()
  const end = job.completion_time ? new Date(job.completion_time).getTime() : now
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  return Math.floor((end - start) / 1000)
}

// The server's status (jobrow.Status) stands; a row with none reads by its counts. The summary cards read this string too.
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

// kubectl's COMPLETIONS, which the server writes: the row's completions alone cannot tell a work queue.
export function jobCompletionsCell(job: { completions_text?: string | null }): string {
  return job.completions_text || '-'
}

// Only a Job that ended is Completed or Failed (FailureTarget is not yet); the rest is Running, so the cards add up to the total.
export function jobSummary(jobs: Array<{ status: string }>): { total: number; completed: number; running: number; failed: number } {
  let completed = 0
  let failed = 0
  for (const job of jobs) {
    if (job.status === 'Complete') completed += 1
    else if (job.status === 'Failed') failed += 1
  }
  return { total: jobs.length, completed, running: jobs.length - completed - failed, failed }
}

export function getJobStatusColor(status: string): string {
  const lower = String(status || '').toLowerCase()
  if (lower.includes('complete') || lower.includes('succeeded') || lower.includes('successcriteriamet')) return 'badge-success'
  if (lower.includes('running') || lower.includes('pending') || lower.includes('suspend') || lower.includes('terminating')) return 'badge-warning'
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
