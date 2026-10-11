// Gateways 페이지의 helper 함수 및 type
//
// frontend/src/pages/gateway/Gateways.tsx 의 parseAgeSeconds / formatAge /
// inferGatewayStatus / gatewayToRawJson + SortKey 타입 추출.
// inferGatewayStatus 는 conditions 배열에서 Programmed > Accepted > 첫 True >
// 첫 False+'(False)' > 'Unknown' 우선순위로 statusText 결정.

import type { GatewayInfo } from '@/services/api'

export type SortKey =
  | null
  | 'name'
  | 'namespace'
  | 'class'
  | 'status'
  | 'listeners'
  | 'routes'
  | 'addresses'
  | 'age'

export { ageSeconds as parseAgeSeconds, formatAge } from '@/utils/time'

export function inferGatewayStatus(conditions: any[]): string {
  const list = Array.isArray(conditions) ? conditions : []
  const programmed = list.find((c) => String(c?.type) === 'Programmed' && String(c?.status).toLowerCase() === 'true')
  if (programmed) return 'Programmed'
  const accepted = list.find((c) => String(c?.type) === 'Accepted' && String(c?.status).toLowerCase() === 'true')
  if (accepted) return 'Accepted'
  const firstTrue = list.find((c) => String(c?.status).toLowerCase() === 'true')
  if (firstTrue?.type) return String(firstTrue.type)
  const firstFalse = list.find((c) => String(c?.status).toLowerCase() === 'false')
  if (firstFalse?.type) return `${String(firstFalse.type)}(False)`
  return 'Unknown'
}

export function gatewayToRawJson(gateway: GatewayInfo): Record<string, unknown> {
  return {
    apiVersion: gateway.api_version || 'gateway.networking.k8s.io/v1',
    kind: 'Gateway',
    metadata: {
      name: gateway.name,
      namespace: gateway.namespace,
      labels: gateway.labels || {},
      annotations: gateway.annotations || {},
      finalizers: gateway.finalizers || [],
      creationTimestamp: gateway.created_at,
    },
    spec: {
      gatewayClassName: gateway.gateway_class_name || undefined,
      listeners: gateway.listeners || [],
    },
    status: {
      addresses: gateway.addresses || [],
      listeners: gateway.status_listeners || [],
      conditions: gateway.conditions || [],
    },
  }
}
