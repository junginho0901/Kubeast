// IngressClasses watch event 정규화 + 적용 helper
//
// frontend/src/pages/network/IngressClasses.tsx 의
// normalizeWatchIngressClassObject / applyIngressClassWatchEvent 추출.
// raw k8s IngressClass object 를 API list 형태 (IngressClassInfo) 로 정규화 —
// is_default 는 annotation `ingressclass.kubernetes.io/is-default-class==='true'` 로 판정,
// spec.parameters 의 apiGroup/kind/name/scope/namespace 정규화 (snake_case).

import { mergeWatchUpdate } from '@/services/mergeWatchUpdate'
import type { IngressClassInfo } from '@/services/api'

export function normalizeWatchIngressClassObject(obj: any): IngressClassInfo {
  if (typeof obj?.name === 'string' && Object.prototype.hasOwnProperty.call(obj, 'is_default')) {
    return {
      ...obj,
      labels: obj?.labels || {},
      annotations: obj?.annotations || {},
      finalizers: Array.isArray(obj?.finalizers) ? obj.finalizers : [],
    } as IngressClassInfo
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const annotations = metadata?.annotations ?? {}
  const labels = metadata?.labels ?? {}
  const paramObj = spec?.parameters
    ? {
        api_group: spec.parameters?.apiGroup ?? null,
        kind: spec.parameters?.kind ?? null,
        name: spec.parameters?.name ?? null,
        scope: spec.parameters?.scope ?? null,
        namespace: spec.parameters?.namespace ?? null,
      }
    : null

  return {
    name: metadata?.name ?? '',
    controller: spec?.controller ?? null,
    is_default: annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true',
    parameters: paramObj,
    labels,
    annotations,
    finalizers: Array.isArray(metadata?.finalizers) ? metadata.finalizers : [],
    created_at: metadata?.creationTimestamp ?? null,
  }
}

export function applyIngressClassWatchEvent(
  prev: IngressClassInfo[] | undefined,
  event: { type?: string; object?: any },
): IngressClassInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchIngressClassObject(obj)
  const name = normalized?.name
  if (!name) return items

  const index = items.findIndex((item) => item.name === name)

  if (event.type === 'DELETED') {
    if (index >= 0) items.splice(index, 1)
    return items
  }

  if (index >= 0) items[index] = mergeWatchUpdate(items[index], normalized)
  else items.push(normalized)
  return items
}
