// GatewayClasses watch event 정규화 + 적용 helper
//
// frontend/src/pages/gateway/GatewayClasses.tsx 의
// normalizeWatchGatewayClassObject / applyGatewayClassWatchEvent 추출.
// raw k8s GatewayClass (Gateway API gateway.networking.k8s.io/v1) object 를
// API list 형태 (GatewayClassInfo) 로 정규화 — status.conditions 기반 Accepted
// 판정 (Gateway 와 달리 Programmed 없이 Accepted 만, statusText 4단계 우선순위).
// cluster-scoped 라 namespace 부재.

import { mergeWatchUpdate } from '@/services/mergeWatchUpdate'
import type { GatewayClassInfo } from '@/services/api'

export function normalizeWatchGatewayClassObject(obj: any): GatewayClassInfo {
  if (
    typeof obj?.name === 'string'
    && Object.prototype.hasOwnProperty.call(obj, 'controller_name')
  ) {
    return {
      ...obj,
      parameters_ref: obj.parameters_ref || null,
      conditions: Array.isArray(obj.conditions) ? obj.conditions : [],
      labels: obj.labels || {},
      annotations: obj.annotations || {},
      finalizers: Array.isArray(obj.finalizers) ? obj.finalizers : [],
    } as GatewayClassInfo
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}
  const conditions = Array.isArray(status?.conditions) ? status.conditions : []

  const accepted = conditions.some(
    (c: any) => String(c?.type) === 'Accepted' && String(c?.status).toLowerCase() === 'true',
  )

  const trueCondition = conditions.find((c: any) => String(c?.status).toLowerCase() === 'true')
  const falseCondition = conditions.find((c: any) => String(c?.status).toLowerCase() === 'false')
  const statusText = accepted
    ? 'Accepted'
    : trueCondition?.type
      ? String(trueCondition.type)
      : falseCondition?.type
        ? `${String(falseCondition.type)}(False)`
        : 'Unknown'

  return {
    name: metadata?.name ?? obj?.name ?? '',
    controller_name: spec?.controllerName ?? obj?.controller_name ?? null,
    description: metadata?.annotations?.['gateway.networking.k8s.io/description'] ?? obj?.description ?? null,
    accepted,
    status: statusText,
    parameters_ref: spec?.parametersRef ?? obj?.parameters_ref ?? null,
    conditions,
    labels: metadata?.labels ?? obj?.labels ?? {},
    annotations: metadata?.annotations ?? obj?.annotations ?? {},
    finalizers: Array.isArray(metadata?.finalizers) ? metadata.finalizers : (obj?.finalizers || []),
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
    api_version: obj?.apiVersion ?? obj?.api_version ?? null,
  }
}

export function applyGatewayClassWatchEvent(
  prev: GatewayClassInfo[] | undefined,
  event: { type?: string; object?: any },
): GatewayClassInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchGatewayClassObject(obj)
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
