// CronJob watch event 의 raw k8s 객체 → API list 형태로 정규화
//
// frontend/src/pages/workloads/CronJobs.tsx 의 normalizeWatchCronJobObject +
// applyCronJobWatchEvent 추출. useKubeWatchList 의 applyEvent 콜백에서만 사용
// (raw watch event → 기존 list state 에 병합). active 는 raw k8s 의 status.active
// (Job 참조 배열) 의 length 로 환산.

import { mergeWatchUpdate } from '@/services/mergeWatchUpdate'
import type { CronJobInfo } from '@/services/api'

export function normalizeWatchCronJobObject(obj: any): CronJobInfo {
  if (
    typeof obj?.name === 'string'
    && typeof obj?.namespace === 'string'
    && typeof obj?.schedule === 'string'
  ) {
    return {
      ...obj,
      suspend: Boolean(obj?.suspend),
      active: Number(obj?.active || 0),
      containers: Array.isArray(obj?.containers) ? obj.containers : [],
      images: Array.isArray(obj?.images) ? obj.images : [],
    } as CronJobInfo
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}
  const templateSpec = spec?.jobTemplate?.spec?.template?.spec ?? {}
  const containers = Array.isArray(templateSpec?.containers) ? templateSpec.containers : []

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    schedule: spec?.schedule ?? obj?.schedule ?? '-',
    suspend: Boolean(spec?.suspend ?? obj?.suspend ?? false),
    concurrency_policy: spec?.concurrencyPolicy ?? obj?.concurrency_policy ?? null,
    active: Array.isArray(status?.active) ? status.active.length : Number(obj?.active || 0),
    last_schedule_time: status?.lastScheduleTime ?? obj?.last_schedule_time ?? null,
    last_successful_time: status?.lastSuccessfulTime ?? obj?.last_successful_time ?? null,
    containers: containers.map((container: any) => container?.name).filter(Boolean),
    images: containers.map((container: any) => container?.image).filter(Boolean),
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
  }
}

export function applyCronJobWatchEvent(
  prev: CronJobInfo[] | undefined,
  event: { type?: string; object?: any },
): CronJobInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchCronJobObject(obj)
  const name = normalized?.name
  const namespace = normalized?.namespace
  if (!name || !namespace) return items

  const key = `${namespace}/${name}`
  const index = items.findIndex((item) => `${item.namespace}/${item.name}` === key)

  if (event.type === 'DELETED') {
    if (index >= 0) items.splice(index, 1)
    return items
  }

  if (index >= 0) items[index] = mergeWatchUpdate(items[index], normalized)
  else items.push(normalized)
  return items
}
