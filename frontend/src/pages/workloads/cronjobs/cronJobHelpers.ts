// CronJobs 페이지의 순수 helper 함수 / 타입 모음
//
// frontend/src/pages/workloads/CronJobs.tsx 의 상단 helper 3개 + rawJson 빌더 + SortKey 추출.
// 모두 순수 함수 (외부 상태 의존 X). watch event 정규화는 cronJobWatchNormalize.ts.

import type { CronJobInfo } from '@/services/api'
import { nextCronRun } from '@/utils/cron'
import { utcTitle } from '@/utils/time'

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

export { ageSeconds as parseAgeSeconds, formatAge, formatTime as formatTimestamp } from '@/utils/time'

type NextRunFields = Pick<CronJobInfo, 'schedule' | 'suspend' | 'time_zone'> & Partial<Pick<CronJobInfo, 'last_schedule_time' | 'created_at'>>

/** The next run of a CronJob that is not suspended (D11, utils/cron); `@every` counts from the last schedule. */
export function nextRunOf(cronjob: NextRunFields): Date | null {
  return cronjob.suspend ? null : nextCronRun(cronjob.schedule, cronjob.time_zone, new Date(), cronjob.last_schedule_time ?? cronjob.created_at)
}

/** Tooltip of the next run: the UTC value and the zone the schedule is read in. */
export function nextRunTitle(
  cronjob: NextRunFields,
  tr: (key: string, fallback: string, options?: Record<string, unknown>) => string,
): string | undefined {
  const next = nextRunOf(cronjob)
  if (!next) return cronjob.suspend ? tr('cronjobs.nextRunSuspended', 'Suspended: no run is scheduled') : undefined
  const zone = cronjob.time_zone || tr('cronjobs.controllerZone', "the controller's time zone (not set; computed in this browser's zone)")
  return tr('cronjobs.nextRunTitle', 'UTC {{utc}} · {{zone}}', { utc: utcTitle(next), zone })
}

type Fields = Record<string, unknown>

// The fields a CronJob's next run is worked out from: the describe answer's, else the row's.
export function cronJobNextRunFields(describe: Fields | null | undefined, spec: Fields, status: Fields): NextRunFields {
  return {
    schedule: String(describe?.schedule ?? spec.schedule ?? ''),
    suspend: Boolean(describe?.suspend ?? spec.suspend),
    time_zone: describe?.time_zone ? String(describe.time_zone) : null,
    last_schedule_time: (describe?.last_schedule_time ?? status.lastScheduleTime ?? null) as string | null,
    created_at: describe?.created_at ? String(describe.created_at) : null,
  }
}

// The CronJob window's CronJob Info rows, each undefined where the window has no row for it or says something of its own
// (a time zone not set, no next run): the window draws these and the floating chat is told them.
export function cronJobDrawerInfo(describe: Fields | null | undefined, spec: Fields, status: Fields) {
  const text = (value: unknown, unit = '') => (value == null ? undefined : `${String(value)}${unit}`)
  const next = nextRunOf(cronJobNextRunFields(describe, spec, status))
  return {
    schedule: String(describe?.schedule ?? spec.schedule ?? '-'),
    suspend: (describe?.suspend ?? spec.suspend) ? 'Yes' : 'No',
    concurrency_policy: String(describe?.concurrency_policy ?? spec.concurrencyPolicy ?? '-'),
    starting_deadline: text(describe?.starting_deadline_seconds ?? spec.startingDeadlineSeconds, 's'),
    successful_jobs_history: text(describe?.successful_jobs_history_limit),
    failed_jobs_history: text(describe?.failed_jobs_history_limit),
    time_zone: describe?.time_zone ? String(describe.time_zone) : undefined,
    next_run: next ? next.toISOString() : undefined,
    active_jobs: String(describe?.active ?? (Array.isArray(status.active) ? status.active.length : 0)),
    last_schedule: text(describe?.last_schedule_time ?? status.lastScheduleTime),
    last_successful: text(describe?.last_successful_time ?? status.lastSuccessfulTime),
  }
}

export type CronJobDrawerInfo = ReturnType<typeof cronJobDrawerInfo>

// The floating chat is told the window's rows as the window words them, a time zone not set too.
export function cronJobLayerFields(info: CronJobDrawerInfo, controllerZone: string): Fields {
  return { ...info, time_zone: info.time_zone ?? controllerZone }
}

export function cronJobLayerHeadline(info: CronJobDrawerInfo): string {
  return [
    `Schedule ${info.schedule}`,
    `Suspend ${info.suspend}`,
    `Concurrency Policy ${info.concurrency_policy}`,
    `Active Jobs ${info.active_jobs}`,
    ...(info.next_run ? [`Next Run ${info.next_run}`] : []),
    ...(info.last_schedule ? [`Last Schedule ${info.last_schedule}`] : []),
  ].join(', ')
}

// As the issues read it (k8s-service issuesFromJobs, LastRunNotSucceeded): the last scheduled run has not succeeded and none is active.
export function cronJobLayerNeedsALook(info: CronJobDrawerInfo): boolean {
  if (!info.last_schedule || Number(info.active_jobs) > 0) return false
  return !info.last_successful || info.last_successful < info.last_schedule
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
