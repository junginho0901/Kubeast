// Job watch event 의 raw k8s 객체 → API list 형태로 정규화
//
// frontend/src/pages/workloads/Jobs.tsx 의 normalizeWatchJobObject +
// applyJobWatchEvent 추출. useKubeWatchList 의 applyEvent 콜백에서만 사용
// (raw watch event → 기존 list state 에 반영). start_time/completion_time 기반
// duration_seconds 계산도 이 안에서 수행.

import type { JobInfo } from '@/services/api'

// The server's rule (jobrow.Status, kubectl's printJob), for a row it could not convert.
function statusOfObject(conditions: unknown, deleting: boolean): string {
  const list: any[] = Array.isArray(conditions) ? conditions : []
  const holds = (type: string) => list.find((c) => c?.type === type)?.status === 'True'
  if (holds('Complete')) return 'Complete'
  if (holds('Failed')) return 'Failed'
  if (deleting) return 'Terminating'
  if (holds('Suspended')) return 'Suspended'
  if (holds('FailureTarget')) return 'FailureTarget'
  if (holds('SuccessCriteriaMet')) return 'SuccessCriteriaMet'
  return 'Running'
}

// The server's completionsText, for the same row.
function completionsOfObject(completions: unknown, parallelism: unknown, succeeded: unknown): string {
  const done = Number(succeeded ?? 0)
  if (completions != null) return `${done}/${completions}`
  return Number(parallelism ?? 0) > 1 ? `${done}/1 of ${parallelism}` : `${done}/1`
}

export function normalizeWatchJobObject(obj: any): JobInfo {
  if (typeof obj?.name === 'string' && typeof obj?.namespace === 'string' && typeof obj?.status === 'string') {
    return obj as JobInfo
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}
  const templateSpec = spec?.template?.spec ?? {}
  const containers = Array.isArray(templateSpec?.containers) ? templateSpec.containers : []

  let durationSeconds: number | null = null
  const startTime = status?.startTime ? String(status.startTime) : null
  const completionTime = status?.completionTime ? String(status.completionTime) : null
  if (startTime && completionTime) {
    const start = new Date(startTime).getTime()
    const end = new Date(completionTime).getTime()
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      durationSeconds = Math.floor((end - start) / 1000)
    }
  }

  const rawOwnerRefs = Array.isArray(metadata?.ownerReferences)
    ? metadata.ownerReferences
    : (Array.isArray(obj?.owner_references) ? obj.owner_references : [])
  const ownerReferences = rawOwnerRefs.map((r: any) => ({
    kind: r?.kind ?? null,
    name: r?.name ?? null,
    uid: r?.uid ?? null,
    controller: r?.controller ?? null,
  }))

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    completions: spec?.completions ?? obj?.completions ?? null,
    completions_text: completionsOfObject(spec?.completions ?? obj?.completions, spec?.parallelism ?? obj?.parallelism, status?.succeeded ?? obj?.succeeded),
    parallelism: spec?.parallelism ?? obj?.parallelism ?? null,
    active: status?.active ?? obj?.active ?? 0,
    succeeded: status?.succeeded ?? obj?.succeeded ?? 0,
    failed: status?.failed ?? obj?.failed ?? 0,
    status: statusOfObject(status?.conditions, !!metadata?.deletionTimestamp),
    containers: containers.map((container: any) => container?.name).filter(Boolean),
    images: containers.map((container: any) => container?.image).filter(Boolean),
    start_time: startTime ?? obj?.start_time ?? null,
    completion_time: completionTime ?? obj?.completion_time ?? null,
    duration_seconds: durationSeconds ?? obj?.duration_seconds ?? null,
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
    owner_references: ownerReferences,
  }
}

export function applyJobWatchEvent(
  prev: JobInfo[] | undefined,
  event: { type?: string; object?: any },
): JobInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchJobObject(obj)
  const name = normalized?.name
  const namespace = normalized?.namespace
  if (!name || !namespace) return items

  const key = `${namespace}/${name}`
  const index = items.findIndex((item) => `${item.namespace}/${item.name}` === key)

  if (event.type === 'DELETED') {
    if (index >= 0) items.splice(index, 1)
    return items
  }

  // the server sends the whole row (jobrow.Info), so it replaces: an owner or start time that went away goes
  if (index >= 0) items[index] = normalized
  else items.push(normalized)
  return items
}
