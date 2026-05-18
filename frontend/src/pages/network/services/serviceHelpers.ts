// Services 페이지의 helper 함수 및 type
//
// frontend/src/pages/network/Services.tsx 의 parseAgeSeconds / formatAge /
// formatPorts / formatSelector / serviceToRawJson + SortKey 타입 추출.
// 순수 함수 + 타입 정의.

import type { ServiceInfo } from '@/services/api'

export type SortKey =
  | null
  | 'name'
  | 'type'
  | 'clusterIp'
  | 'externalIp'
  | 'ports'
  | 'selector'
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

export function formatPorts(ports: ServiceInfo['ports']): string {
  if (!Array.isArray(ports) || ports.length === 0) return '-'
  return ports
    .map((p) => {
      const protocol = p.protocol || 'TCP'
      const port = p.port
      const targetPort = p.target_port || '-'
      if (p.node_port != null) {
        return `${protocol} ${port}->${targetPort} (node:${p.node_port})`
      }
      return `${protocol} ${port}->${targetPort}`
    })
    .join(', ')
}

export function formatSelector(selector: Record<string, string>): string {
  const entries = Object.entries(selector || {})
  if (entries.length === 0) return '-'
  return entries.map(([k, v]) => `${k}=${v}`).join(', ')
}

export function serviceToRawJson(service: ServiceInfo): Record<string, unknown> {
  const externalIPs = service.external_ip ? [service.external_ip] : []

  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: service.name,
      namespace: service.namespace,
      creationTimestamp: service.created_at,
    },
    spec: {
      type: service.type,
      clusterIP: service.cluster_ip,
      externalIPs,
      selector: service.selector || {},
      ports: (service.ports || []).map((port) => ({
        name: port.name,
        port: port.port,
        targetPort: port.target_port,
        nodePort: port.node_port,
        protocol: port.protocol,
      })),
    },
    status: {
      loadBalancer: {
        ingress: service.external_ip ? [{ ip: service.external_ip }] : [],
      },
    },
  }
}
