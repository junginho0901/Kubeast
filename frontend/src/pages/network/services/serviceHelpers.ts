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

export { ageSeconds as parseAgeSeconds, formatAge } from '@/utils/time'

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
