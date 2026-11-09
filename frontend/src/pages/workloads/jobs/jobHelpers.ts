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

// A card counts the rows reading Complete, Failed or Suspended (FailureTarget has not ended); the rest is Running, so the cards add up.
export function jobSummary(jobs: Array<{ status: string }>): { total: number; completed: number; running: number; suspended: number; failed: number } {
  let completed = 0
  let failed = 0
  let suspended = 0
  for (const job of jobs) {
    if (job.status === 'Complete') completed += 1
    else if (job.status === 'Failed') failed += 1
    else if (job.status === 'Suspended') suspended += 1
  }
  return { total: jobs.length, completed, running: jobs.length - completed - failed - suspended, suspended, failed }
}

// The floating chat is told the cards' numbers, which read a Job's Status: its failed pods say nothing of whether it has failed.
export const jobChatStats = jobSummary

const hasFailedPods = (job: { failed?: number }) => (job.failed || 0) > 0
const isRetrying = (job: { status: string; failed?: number }) => job.status === 'Running' && hasFailedPods(job)

export function jobChatNotes(jobs: Array<{ status: string; failed?: number }>): string[] {
  const failed = jobSummary(jobs).failed
  const decided = jobs.filter((j) => j.status === 'FailureTarget').length
  const retrying = jobs.filter(isRetrying).length
  return [
    failed > 0 ? `⚠️ ${failed}개 Job 이 실패 상태` : '',
    decided > 0 ? `⚠️ ${decided}개 Job 이 실패 확정, 파드 정리 중` : '',
    retrying > 0 ? `${retrying}개 Job 이 실패한 파드를 재시도 중` : '',
  ].filter(Boolean)
}

export function jobNeedsALook(job: { status: string; failed?: number }): boolean {
  return job.status === 'Failed' || job.status === 'FailureTarget' || isRetrying(job)
}

// kubectl describe's Completions. Only the describe answer can say a Job has none: the row fills in 1 for the list.
export function jobDrawerCompletions(describe: { completions?: unknown } | null | undefined, spec: { completions?: unknown }): string {
  if (describe) return describe.completions == null ? '<unset>' : String(describe.completions)
  return spec.completions == null ? '-' : String(spec.completions)
}

type Fields = Record<string, unknown>

// The Job window's Job Info rows, each undefined where the window has no row for it: the window draws these and the
// floating chat is told them.
export function jobDrawerInfo(describe: Fields | null | undefined, spec: Fields, status: Fields) {
  const start = describe?.start_time ? String(describe.start_time) : undefined
  const completion = describe?.completion_time ? String(describe.completion_time) : undefined
  const yesNo = (value: unknown) => (value == null ? undefined : value ? 'Yes' : 'No')
  const text = (value: unknown, unit = '') => (value == null ? undefined : `${String(value)}${unit}`)
  return {
    completions: jobDrawerCompletions(describe, spec),
    parallelism: String(describe?.parallelism ?? spec.parallelism ?? '-'),
    active: String(describe?.active ?? status.active ?? 0),
    succeeded: String(describe?.succeeded ?? status.succeeded ?? 0),
    failed: String(describe?.failed ?? status.failed ?? 0),
    status: describe?.status ? String(describe.status) : undefined,
    start_time: start,
    completion_time: completion,
    duration: start ? formatDuration(jobDurationSeconds({ start_time: start, completion_time: completion ?? null })) : undefined,
    backoff_limit: text(describe?.backoff_limit),
    active_deadline: text(describe?.active_deadline_seconds, 's'),
    ttl_after_finished: text(describe?.ttl_seconds_after_finished, 's'),
    completion_mode: describe?.completion_mode ? String(describe.completion_mode) : undefined,
    suspend: yesNo(describe?.suspend),
    manual_selector: yesNo(describe?.manual_selector),
  }
}

export type JobDrawerInfo = ReturnType<typeof jobDrawerInfo>

// The floating chat is told the window's rows as the window words them.
export function jobLayerFields(info: JobDrawerInfo): Fields {
  return { ...info }
}

export function jobLayerHeadline(info: JobDrawerInfo): string {
  const counts = `Completions ${info.completions}, Parallelism ${info.parallelism}, Active ${info.active}, Succeeded ${info.succeeded}, Failed ${info.failed}`
  return info.status ? `Status ${info.status}, ${counts}` : counts
}

export function jobLayerNeedsALook(info: JobDrawerInfo): boolean {
  return jobNeedsALook({ status: info.status ?? '', failed: Number(info.failed) })
}

// Green as a Pod's Running and the Resource Graph's: a running Job asks nothing, and yellow is the Issues filter's.
export function getJobStatusColor(status: string): string {
  const lower = String(status || '').toLowerCase()
  if (lower.includes('complete') || lower.includes('succeeded') || lower.includes('successcriteriamet') || lower.includes('running')) return 'badge-success'
  if (lower.includes('pending') || lower.includes('suspend') || lower.includes('terminating')) return 'badge-warning'
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
      // a work queue's 1 is the row's own: its cell says "of N", so this object does not claim it
      completions: / of /.test(job.completions_text ?? '') ? undefined : job.completions,
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
