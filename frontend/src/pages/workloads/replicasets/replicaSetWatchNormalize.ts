// ReplicaSet watch event 의 raw k8s 객체 → API list 형태로 정규화
//
// frontend/src/pages/workloads/ReplicaSets.tsx 의 normalizeWatchReplicaSetObject +
// applyReplicaSetWatchEvent 추출. useKubeWatchList 의 applyEvent 콜백에서만 사용
// (raw watch event → 기존 list state 에 병합).

import { mergeWatchUpdate } from '@/services/mergeWatchUpdate'
import type { ReplicaSetInfo } from '@/services/api'
import { computeReplicaSetStatus } from './replicaSetHelpers'

export function normalizeWatchReplicaSetObject(obj: any): ReplicaSetInfo {
  if (
    typeof obj?.name === 'string' &&
    typeof obj?.namespace === 'string' &&
    typeof obj?.replicas === 'number'
  ) {
    return {
      current_replicas: obj?.current_replicas ?? obj?.replicas ?? 0,
      ...obj,
    } as ReplicaSetInfo
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}
  const templateSpec = spec?.template?.spec ?? {}
  const containers = Array.isArray(templateSpec?.containers) ? templateSpec.containers : []

  const replicas = spec?.replicas ?? 0
  const currentReplicas = status?.replicas ?? 0
  const readyReplicas = status?.readyReplicas ?? 0
  const availableReplicas = status?.availableReplicas ?? 0

  const ownerReferences = Array.isArray(metadata?.ownerReferences) ? metadata.ownerReferences : []
  const owner = ownerReferences.length > 0 && ownerReferences[0]?.kind && ownerReferences[0]?.name
    ? `${ownerReferences[0].kind}/${ownerReferences[0].name}`
    : null

  const selector = spec?.selector?.matchLabels ?? {}
  const images = containers.map((container: any) => container?.image).filter(Boolean)
  const containerNames = containers.map((container: any) => container?.name).filter(Boolean)

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    current_replicas: currentReplicas,
    replicas,
    ready_replicas: readyReplicas,
    available_replicas: availableReplicas,
    image: images[0] ?? '',
    images,
    container_names: containerNames,
    owner,
    labels: metadata?.labels ?? {},
    selector,
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
    status: computeReplicaSetStatus({ replicas, ready_replicas: readyReplicas }),
  }
}

export function applyReplicaSetWatchEvent(
  prev: ReplicaSetInfo[] | undefined,
  event: { type?: string; object?: any },
): ReplicaSetInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchReplicaSetObject(obj)
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
