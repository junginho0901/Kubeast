// ReferenceGrants watch event 정규화 + 적용 helper
//
// frontend/src/pages/gateway/ReferenceGrants.tsx 의
// normalizeWatchReferenceGrantObject / applyReferenceGrantWatchEvent 추출.
// raw k8s ReferenceGrant (Gateway API v1beta1) object 를 API list 형태
// (ReferenceGrantInfo) 로 정규화 — spec.from / spec.to 배열 보존 (각각
// {group, kind, namespace} 또는 {group, kind, name}). conditions 없음
// (ReferenceGrant 는 RBAC-only, status 부재).

import { mergeWatchUpdate } from '@/services/mergeWatchUpdate'
import type { ReferenceGrantInfo } from '@/services/api'

export function normalizeWatchReferenceGrantObject(obj: any): ReferenceGrantInfo {
  if (
    typeof obj?.name === 'string'
    && typeof obj?.namespace === 'string'
    && (Array.isArray(obj?.from) || Array.isArray(obj?.to))
  ) {
    return {
      ...obj,
      from: Array.isArray(obj.from) ? obj.from : [],
      to: Array.isArray(obj.to) ? obj.to : [],
      labels: obj.labels || {},
      annotations: obj.annotations || {},
    } as ReferenceGrantInfo
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    from: Array.isArray(spec?.from) ? spec.from : [],
    to: Array.isArray(spec?.to) ? spec.to : [],
    labels: metadata?.labels ?? obj?.labels ?? {},
    annotations: metadata?.annotations ?? obj?.annotations ?? {},
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
    api_version: obj?.apiVersion ?? obj?.api_version ?? null,
  }
}

export function applyReferenceGrantWatchEvent(
  prev: ReferenceGrantInfo[] | undefined,
  event: { type?: string; object?: any },
): ReferenceGrantInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchReferenceGrantObject(obj)
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
