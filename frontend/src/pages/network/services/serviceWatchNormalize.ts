// Services watch event 정규화 + 적용 helper
//
// frontend/src/pages/network/Services.tsx 의 extractExternalIp /
// normalizeWatchServiceObject / applyServiceWatchEvent 추출.
// raw k8s Service object 를 API list 형태 (ServiceInfo) 로 정규화 —
// spec.ports 의 nodePort/targetPort/protocol 정규화.

import type { ServiceInfo } from '@/services/api'

// The server's rule (servicerow, kubectl's getServiceExternalIP), for a row it could not convert.
function externalIpCell(type: string, spec: any, ingress: Array<{ ip?: string; hostname?: string }>): string {
  const externalIPs: string[] = Array.isArray(spec?.externalIPs) ? spec.externalIPs : []
  switch (type) {
    case 'ClusterIP':
    case 'NodePort':
      return externalIPs.join(',') || '<none>'
    case 'LoadBalancer': {
      const addresses = ingress.map((i) => i?.ip || i?.hostname).filter((a): a is string => !!a)
      return [...[...new Set(addresses)].sort(), ...externalIPs].join(',') || '<pending>'
    }
    case 'ExternalName':
      return spec?.externalName ?? ''
  }
  return '<unknown>'
}

export function normalizeWatchServiceObject(obj: any): ServiceInfo {
  if (
    typeof obj?.name === 'string' &&
    typeof obj?.namespace === 'string' &&
    typeof obj?.type === 'string' &&
    Array.isArray(obj?.ports)
  ) {
    return obj as ServiceInfo
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const type = spec?.type ?? obj?.type ?? 'ClusterIP'
  const ingress = Array.isArray(obj?.status?.loadBalancer?.ingress) ? obj.status.loadBalancer.ingress : []

  const ports = Array.isArray(spec?.ports)
    ? spec.ports.map((p: any) => ({
        name: p?.name,
        port: p?.port,
        target_port: String(p?.targetPort ?? '-'),
        node_port: p?.nodePort ?? null,
        protocol: p?.protocol ?? 'TCP',
      }))
    : []

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    type,
    cluster_ip: spec?.clusterIP ?? obj?.cluster_ip,
    external_ip: externalIpCell(type, spec, ingress),
    external_ips: Array.isArray(spec?.externalIPs) ? spec.externalIPs : [],
    load_balancer_ingress: ingress,
    ports,
    selector: (spec?.selector ?? obj?.selector ?? {}) as Record<string, string>,
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
  }
}

export function applyServiceWatchEvent(
  prev: ServiceInfo[] | undefined,
  event: { type?: string; object?: any },
): ServiceInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchServiceObject(obj)
  const name = normalized?.name
  const namespace = normalized?.namespace
  if (!name || !namespace) return items

  const key = `${namespace}/${name}`
  const index = items.findIndex((item) => `${item.namespace}/${item.name}` === key)

  if (event.type === 'DELETED') {
    if (index >= 0) items.splice(index, 1)
    return items
  }

  // the server sends the whole row (servicerow.Info), so it replaces: a cluster IP, port or selector that went away
  // shows that instead of keeping the old one
  if (index >= 0) items[index] = normalized
  else items.push(normalized)

  return items
}
