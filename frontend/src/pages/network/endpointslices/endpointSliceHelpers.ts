// EndpointSlices 페이지의 helper 함수 및 type
//
// frontend/src/pages/network/EndpointSlices.tsx 의 parseAgeSeconds / formatAge /
// formatPorts / formatEndpointPreview / resolveNotReadyCount /
// endpointSliceToRawJson + SortKey 타입 추출. 순수 함수 + 타입 정의.

import type { EndpointSliceInfo } from '@/services/api'

export type SortKey =
  | null
  | 'name'
  | 'namespace'
  | 'service'
  | 'addressType'
  | 'endpoints'
  | 'ready'
  | 'notReady'
  | 'ports'
  | 'age'

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

export function formatPorts(ports: EndpointSliceInfo['ports']): string {
  if (!Array.isArray(ports) || ports.length === 0) return '-'
  return ports
    .map((p) => {
      const app = p.app_protocol ? ` (${p.app_protocol})` : ''
      return `${p.name || '-'}:${p.port ?? '-'}${p.protocol ? `/${p.protocol}` : ''}${app}`
    })
    .join(', ')
}

export function formatEndpointPreview(row: EndpointSliceInfo): string {
  const total = row.endpoints_total || 0
  const endpoints = Array.isArray(row.endpoints) ? row.endpoints : []
  if (total === 0 || endpoints.length === 0) return '-'
  const addresses = endpoints.flatMap((ep) => ep.addresses || []).filter(Boolean)
  if (addresses.length === 0) return `${total} endpoint${total === 1 ? '' : 's'}`
  const preview = addresses.slice(0, 3).join(', ')
  if (addresses.length <= 3) return preview
  return `${preview} +${addresses.length - 3}`
}

export function resolveNotReadyCount(slice: EndpointSliceInfo): number {
  return slice.endpoints_not_ready ?? Math.max((slice.endpoints_total || 0) - (slice.endpoints_ready || 0), 0)
}

export function endpointSliceToRawJson(slice: EndpointSliceInfo): Record<string, unknown> {
  return {
    apiVersion: 'discovery.k8s.io/v1',
    kind: 'EndpointSlice',
    metadata: {
      name: slice.name,
      namespace: slice.namespace,
      creationTimestamp: slice.created_at,
      labels: slice.labels || {},
      annotations: slice.annotations || {},
    },
    service_name: slice.service_name,
    managed_by: slice.managed_by,
    address_type: slice.address_type,
    endpoints_total: slice.endpoints_total,
    endpoints_ready: slice.endpoints_ready,
    endpoints_not_ready: slice.endpoints_not_ready ?? Math.max((slice.endpoints_total || 0) - (slice.endpoints_ready || 0), 0),
    addressType: slice.address_type,
    endpoints: (slice.endpoints || []).map((ep) => ({
      addresses: ep.addresses || [],
      hostname: ep.hostname,
      nodeName: ep.node_name,
      zone: ep.zone,
      conditions: {
        ready: ep.conditions?.ready,
        serving: ep.conditions?.serving,
        terminating: ep.conditions?.terminating,
      },
      targetRef: ep.target_ref || undefined,
    })),
    ports: (slice.ports || []).map((p) => ({
      name: p.name,
      port: p.port,
      protocol: p.protocol,
      appProtocol: p.app_protocol,
    })),
  }
}
