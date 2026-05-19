// GatewayClasses 페이지의 helper 함수 및 type
//
// frontend/src/pages/gateway/GatewayClasses.tsx 의 parseAgeSeconds / formatAge /
// formatParametersRef / gatewayClassToRawJson + SortKey 타입 추출.
// formatParametersRef 는 kind + .group + /name + ' (ns: namespace)' 누적 형식
// (IngressClasses 의 formatParameters 와 비슷한 패턴). GatewayClass 는
// cluster-scoped (namespace 없음).

import type { GatewayClassInfo } from '@/services/api'

export type SortKey = null | 'name' | 'controller' | 'status' | 'parameters' | 'age'

export function parseAgeSeconds(createdAt?: string | null): number {
  if (!createdAt) return 0
  const ms = new Date(createdAt).getTime()
  if (!Number.isFinite(ms)) return 0
  return Math.max(0, Math.floor((Date.now() - ms) / 1000))
}

export function formatAge(createdAt?: string | null): string {
  const sec = parseAgeSeconds(createdAt)
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export function formatParametersRef(item: GatewayClassInfo): string {
  const ref = item.parameters_ref
  if (!ref || typeof ref !== 'object') return '-'
  const group = String(ref.group || '')
  const kind = String(ref.kind || '')
  const name = String(ref.name || '')
  const namespace = String(ref.namespace || '')
  const pieces = [
    kind || '-',
    group ? `.${group}` : '',
    name ? `/${name}` : '',
    namespace ? ` (ns: ${namespace})` : '',
  ]
  return pieces.join('') || '-'
}

export function gatewayClassToRawJson(item: GatewayClassInfo): Record<string, unknown> {
  return {
    apiVersion: item.api_version || 'gateway.networking.k8s.io/v1',
    kind: 'GatewayClass',
    metadata: {
      name: item.name,
      labels: item.labels || {},
      annotations: item.annotations || {},
      finalizers: item.finalizers || [],
      creationTimestamp: item.created_at,
    },
    spec: {
      controllerName: item.controller_name || undefined,
      parametersRef: item.parameters_ref || undefined,
    },
    status: {
      conditions: item.conditions || [],
    },
    accepted: item.accepted,
    status_text: item.status,
  }
}
