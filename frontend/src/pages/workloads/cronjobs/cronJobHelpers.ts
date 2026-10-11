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

/** The next run of a CronJob that is not suspended (D11, utils/cron). */
export function nextRunOf(cronjob: Pick<CronJobInfo, 'schedule' | 'suspend' | 'time_zone'>): Date | null {
  return cronjob.suspend ? null : nextCronRun(cronjob.schedule, cronjob.time_zone)
}

/** Tooltip of the next run: the UTC value and the zone the schedule is read in. */
export function nextRunTitle(
  cronjob: Pick<CronJobInfo, 'schedule' | 'suspend' | 'time_zone'>,
  tr: (key: string, fallback: string, options?: Record<string, unknown>) => string,
): string | undefined {
  const next = nextRunOf(cronjob)
  if (!next) return cronjob.suspend ? tr('cronjobs.nextRunSuspended', 'Suspended: no run is scheduled') : undefined
  const zone = cronjob.time_zone || tr('cronjobs.controllerZone', "the controller's time zone (not set; computed in this browser's zone)")
  return tr('cronjobs.nextRunTitle', 'UTC {{utc}} · {{zone}}', { utc: utcTitle(next), zone })
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
