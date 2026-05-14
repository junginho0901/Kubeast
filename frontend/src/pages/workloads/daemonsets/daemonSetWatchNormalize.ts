// DaemonSet watch event 의 raw k8s 객체 → API list 형태로 정규화
//
// frontend/src/pages/workloads/DaemonSets.tsx 의 normalizeWatchDaemonSetObject +
// applyDaemonSetWatchEvent 추출. useKubeWatchList 의 applyEvent 콜백에서만 사용
// (raw watch event → 기존 list state 에 병합).

import { mergeWatchUpdate } from '@/services/mergeWatchUpdate'
import type { DaemonSetInfo } from '@/services/api'
import { computeDaemonSetStatus } from './daemonSetHelpers'

export function normalizeWatchDaemonSetObject(obj: any): DaemonSetInfo {
  if (
    typeof obj?.name === 'string' &&
    typeof obj?.namespace === 'string' &&
    typeof obj?.desired === 'number'
  ) {
    return obj as DaemonSetInfo
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}
  const templateSpec = spec?.template?.spec ?? {}

  const desired = status?.desiredNumberScheduled ?? status?.desired_number_scheduled ?? 0
  const current = status?.currentNumberScheduled ?? status?.current_number_scheduled ?? 0
  const ready = status?.numberReady ?? status?.number_ready ?? 0
  const updated = status?.updatedNumberScheduled ?? status?.updated_number_scheduled ?? 0
  const available = status?.numberAvailable ?? status?.number_available ?? 0
  const misscheduled = status?.numberMisscheduled ?? status?.number_misscheduled ?? 0
  const unavailable = status?.numberUnavailable ?? status?.number_unavailable ?? Math.max(desired - ready, 0)

  const images = Array.isArray(templateSpec?.containers)
    ? templateSpec.containers.map((container: any) => container?.image).filter(Boolean)
    : []

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    desired,
    current,
    ready,
    updated,
    available,
    misscheduled,
    unavailable,
    node_selector: templateSpec?.nodeSelector ?? obj?.node_selector ?? {},
    images,
    status: computeDaemonSetStatus({ desired, ready, misscheduled, unavailable }),
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
  }
}

export function applyDaemonSetWatchEvent(
  prev: DaemonSetInfo[] | undefined,
  event: { type?: string; object?: any },
): DaemonSetInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchDaemonSetObject(obj)
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
