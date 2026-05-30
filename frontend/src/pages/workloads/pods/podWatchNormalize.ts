// Pod watch event 의 raw k8s 객체 → API list 형태로 정규화
//
// frontend/src/pages/workloads/Pods.tsx 의 toSerializedContainerState +
// normalizeWatchPodObject + applyPodWatchEvent 추출. useKubeWatchList 의
// applyEvent 콜백에서만 사용 (raw watch event → 기존 list state 에 병합).

import { mergeWatchUpdate } from '@/services/mergeWatchUpdate'
import type { PodInfo } from '@/services/api'

function toSerializedContainerState(state: any): any {
  if (!state || typeof state !== 'object') return undefined
  const waiting = state.waiting
    ? {
        reason: state.waiting.reason ?? null,
        message: state.waiting.message ?? null,
      }
    : undefined
  const terminated = state.terminated
    ? {
        reason: state.terminated.reason ?? null,
        message: state.terminated.message ?? null,
        exit_code: state.terminated.exitCode ?? state.terminated.exit_code ?? null,
        signal: state.terminated.signal ?? null,
        started_at: state.terminated.startedAt ?? state.terminated.started_at ?? null,
        finished_at: state.terminated.finishedAt ?? state.terminated.finished_at ?? null,
      }
    : undefined
  const running = state.running
    ? {
        started_at: state.running.startedAt ?? state.running.started_at ?? null,
      }
    : undefined

  const result: Record<string, any> = {}
  if (waiting) result.waiting = waiting
  if (terminated) result.terminated = terminated
  if (running) result.running = running
  return Object.keys(result).length > 0 ? result : undefined
}

function normalizeWatchPodObject(obj: any): PodInfo {
  // already normalized (API list shape)
  if (typeof obj?.status === 'string' && typeof obj?.namespace === 'string' && typeof obj?.name === 'string') {
    return obj as PodInfo
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}
  const name = metadata?.name ?? obj?.name ?? ''
  const namespace = metadata?.namespace ?? obj?.namespace ?? ''

  const specContainers = Array.isArray(spec?.containers) ? spec.containers : []
  const specByName = new Map<string, { limits: any; requests: any; ports: any[] }>(
    specContainers.map((c: any) => [
      c?.name,
      {
        limits: c?.resources?.limits ?? null,
        requests: c?.resources?.requests ?? null,
        ports: Array.isArray(c?.ports)
          ? c.ports.map((p: any) => ({
              name: p?.name ?? null,
              container_port: p?.containerPort ?? p?.container_port ?? null,
              protocol: p?.protocol ?? null,
            }))
          : [],
      },
    ]),
  )

  const rawContainerStatuses = Array.isArray(status?.containerStatuses) ? status.containerStatuses : []
  const rawInitStatuses = Array.isArray(status?.initContainerStatuses) ? status.initContainerStatuses : []

  const mapStatus = (containerStatus: any) => {
    const ref: { limits: any; requests: any; ports: any[] } =
      specByName.get(containerStatus?.name) ?? { limits: null, requests: null, ports: [] }
    return {
      name: containerStatus?.name ?? '',
      image: containerStatus?.image ?? '',
      ready: Boolean(containerStatus?.ready),
      restart_count: containerStatus?.restartCount ?? containerStatus?.restart_count ?? 0,
      state: toSerializedContainerState(containerStatus?.state),
      last_state: toSerializedContainerState(containerStatus?.lastState ?? containerStatus?.last_state),
      limits: ref.limits,
      requests: ref.requests,
      ports: ref.ports,
    }
  }

  const containers = rawContainerStatuses.length > 0
    ? rawContainerStatuses.map(mapStatus)
    : (Array.isArray(obj?.containers) ? obj.containers : [])

  const init_containers = rawInitStatuses.length > 0
    ? rawInitStatuses.map(mapStatus)
    : (Array.isArray(obj?.init_containers) ? obj.init_containers : [])

  const readyContainers = containers.filter((c: any) => Boolean(c?.ready)).length
  const totalContainers = containers.length

  const phase = status?.phase ?? obj?.phase ?? (typeof obj?.status === 'string' ? obj.status : 'Unknown')
  const restartCount = containers.reduce((sum: number, c: any) => sum + (c?.restart_count ?? 0), 0)

  const ownerReferences = Array.isArray(metadata?.ownerReferences)
    ? metadata.ownerReferences
    : (Array.isArray(obj?.owner_references) ? obj.owner_references : [])

  // ConfigMap / Secret references — extracted from raw spec when present,
  // falling back to backend-summarized fields for list responses.
  const cmRefs = new Set<string>()
  const secretRefs = new Set<string>()
  const volumesArr = Array.isArray(spec?.volumes) ? spec.volumes : []
  for (const v of volumesArr) {
    if (v?.configMap?.name) cmRefs.add(v.configMap.name)
    if (v?.secret?.secretName) secretRefs.add(v.secret.secretName)
    const sources = Array.isArray(v?.projected?.sources) ? v.projected.sources : []
    for (const s of sources) {
      if (s?.configMap?.name) cmRefs.add(s.configMap.name)
      if (s?.secret?.name) secretRefs.add(s.secret.name)
    }
  }
  const collectEnv = (list: any[]) => {
    for (const c of list ?? []) {
      for (const e of c?.envFrom ?? []) {
        if (e?.configMapRef?.name) cmRefs.add(e.configMapRef.name)
        if (e?.secretRef?.name) secretRefs.add(e.secretRef.name)
      }
      for (const e of c?.env ?? []) {
        if (e?.valueFrom?.configMapKeyRef?.name) cmRefs.add(e.valueFrom.configMapKeyRef.name)
        if (e?.valueFrom?.secretKeyRef?.name) secretRefs.add(e.valueFrom.secretKeyRef.name)
      }
    }
  }
  collectEnv(spec?.containers)
  collectEnv(spec?.initContainers)
  for (const ips of spec?.imagePullSecrets ?? []) {
    if (ips?.name) secretRefs.add(ips.name)
  }
  for (const n of Array.isArray(obj?.config_map_refs) ? obj.config_map_refs : []) {
    if (n) cmRefs.add(n)
  }
  for (const n of Array.isArray(obj?.secret_refs) ? obj.secret_refs : []) {
    if (n) secretRefs.add(n)
  }

  return {
    name,
    namespace,
    status: phase,
    phase,
    status_reason: status?.reason ?? obj?.status_reason ?? null,
    status_message: status?.message ?? obj?.status_message ?? null,
    node_name: spec?.nodeName ?? obj?.node_name ?? null,
    pod_ip: status?.podIP ?? obj?.pod_ip ?? null,
    containers,
    init_containers,
    labels: metadata?.labels ?? obj?.labels ?? {},
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
    restart_count: restartCount,
    ready: totalContainers > 0 ? `${readyContainers}/${totalContainers}` : (obj?.ready ?? '0/0'),
    owner_references: ownerReferences.map((r: any) => ({
      kind: r?.kind ?? null,
      name: r?.name ?? null,
      uid: r?.uid ?? null,
      controller: r?.controller ?? null,
    })),
    service_account_name: spec?.serviceAccountName ?? obj?.service_account_name ?? undefined,
    config_map_refs: cmRefs.size > 0 ? Array.from(cmRefs) : undefined,
    secret_refs: secretRefs.size > 0 ? Array.from(secretRefs) : undefined,
    priority_class_name: spec?.priorityClassName ?? obj?.priority_class_name ?? undefined,
    runtime_class_name: spec?.runtimeClassName ?? obj?.runtime_class_name ?? undefined,
  }
}

export function applyPodWatchEvent(prev: PodInfo[] | undefined, event: { type?: string; object?: any }): PodInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchPodObject(obj)
  const name = normalized?.name
  const namespace = normalized?.namespace
  if (!name || !namespace) return items

  const key = `${namespace}/${name}`
  const index = items.findIndex((item) => `${item.namespace}/${item.name}` === key)

  if (event.type === 'DELETED') {
    if (index >= 0) items.splice(index, 1)
    return items
  }

  if (index >= 0) {
    items[index] = mergeWatchUpdate(items[index], normalized)
  } else {
    items.push(normalized)
  }
  return items
}
