// Deployment watch event 의 raw k8s 객체 → API list 형태로 정규화
//
// frontend/src/pages/workloads/Deployments.tsx 의 normalizeWatchDeploymentObject +
// applyDeploymentWatchEvent 추출. useKubeWatchList 의 applyEvent 콜백에서만 사용
// (raw watch event → 기존 list state 에 병합).

import { mergeWatchUpdate } from '@/services/mergeWatchUpdate'
import type { DeploymentInfo } from '@/services/api'
import { computeDeploymentStatus } from './deploymentHelpers'

export function normalizeWatchDeploymentObject(obj: any): DeploymentInfo {
  if (
    typeof obj?.name === 'string' &&
    typeof obj?.namespace === 'string' &&
    typeof obj?.replicas === 'number'
  ) {
    return obj as DeploymentInfo
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}

  const replicas = spec?.replicas ?? 0
  const readyReplicas = status?.readyReplicas ?? 0
  const availableReplicas = status?.availableReplicas ?? 0
  const updatedReplicas = status?.updatedReplicas ?? 0
  const image = spec?.template?.spec?.containers?.[0]?.image ?? ''

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    replicas,
    ready_replicas: readyReplicas,
    available_replicas: availableReplicas,
    updated_replicas: updatedReplicas,
    image,
    labels: metadata?.labels ?? obj?.labels ?? {},
    selector: spec?.selector?.matchLabels ?? obj?.selector ?? {},
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
    status: computeDeploymentStatus(replicas, readyReplicas),
  }
}

export function applyDeploymentWatchEvent(
  prev: DeploymentInfo[] | undefined,
  event: { type?: string; object?: any },
): DeploymentInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchDeploymentObject(obj)
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
