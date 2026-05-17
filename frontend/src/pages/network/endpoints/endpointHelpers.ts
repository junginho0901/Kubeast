// Endpoints 페이지의 helper 함수 및 type
//
// frontend/src/pages/network/Endpoints.tsx 의 parseAgeSeconds / formatAge /
// formatPorts / formatAddresses / getEndpointAddressCount /
// endpointToRawJson + SortKey 타입 추출. 순수 함수 + 타입 정의.

import type { EndpointInfo } from '@/services/api'

export type SortKey = null | 'name' | 'namespace' | 'ready' | 'notReady' | 'addresses' | 'ports' | 'age'

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

export function formatPorts(ports: EndpointInfo['ports']): string {
  if (!Array.isArray(ports) || ports.length === 0) return '-'
  return ports
    .map((p) => `${p.name || '-'}:${p.port ?? '-'}${p.protocol ? `/${p.protocol}` : ''}`)
    .join(', ')
}

export function formatAddresses(row: EndpointInfo): string {
  const ready = row.ready_addresses || []
  const notReady = row.not_ready_addresses || []
  if (ready.length === 0 && notReady.length === 0) return '-'
  if (notReady.length === 0) return ready.join(', ')
  return `${ready.join(', ')} | not-ready: ${notReady.join(', ')}`
}

export function getEndpointAddressCount(row: EndpointInfo): number {
  return (row.ready_count || 0) + (row.not_ready_count || 0)
}

export function endpointToRawJson(endpoint: EndpointInfo): Record<string, unknown> {
  const toAddress = (target: NonNullable<EndpointInfo['ready_targets']>[number]) => ({
    ip: target?.ip,
    nodeName: target?.node_name,
    targetRef: target?.target_ref || undefined,
  })

  const addressesFromTargets = (endpoint.ready_targets || []).map(toAddress)
  const notReadyFromTargets = (endpoint.not_ready_targets || []).map(toAddress)

  const addresses = addressesFromTargets.length > 0
    ? addressesFromTargets
    : (endpoint.ready_addresses || []).map((ip) => ({ ip }))

  const notReadyAddresses = notReadyFromTargets.length > 0
    ? notReadyFromTargets
    : (endpoint.not_ready_addresses || []).map((ip) => ({ ip }))

  const subsets = (addresses.length > 0 || notReadyAddresses.length > 0 || (endpoint.ports || []).length > 0)
    ? [{
        addresses,
        notReadyAddresses,
        ports: (endpoint.ports || []).map((p) => ({
          name: p.name,
          port: p.port,
          protocol: p.protocol,
        })),
      }]
    : []

  return {
    apiVersion: 'v1',
    kind: 'Endpoints',
    metadata: {
      name: endpoint.name,
      namespace: endpoint.namespace,
      creationTimestamp: endpoint.created_at,
    },
    ready_count: endpoint.ready_count,
    not_ready_count: endpoint.not_ready_count,
    ready_addresses: endpoint.ready_addresses || [],
    not_ready_addresses: endpoint.not_ready_addresses || [],
    ready_targets: endpoint.ready_targets || [],
    not_ready_targets: endpoint.not_ready_targets || [],
    ports: endpoint.ports || [],
    subsets,
  }
}
