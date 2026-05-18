// Services watch event 정규화 + 적용 helper
//
// frontend/src/pages/network/Services.tsx 의 extractExternalIp /
// normalizeWatchServiceObject / applyServiceWatchEvent 추출.
// raw k8s Service object 를 API list 형태 (ServiceInfo) 로 정규화 —
// status.loadBalancer.ingress[0].ip/hostname 또는 spec.externalIPs[0] 우선순위로
// external_ip 추출, spec.ports 의 nodePort/targetPort/protocol 정규화.

import { mergeWatchUpdate } from '@/services/mergeWatchUpdate'
import type { ServiceInfo } from '@/services/api'

function extractExternalIp(obj: any): string | undefined {
  const statusLbIngress = obj?.status?.loadBalancer?.ingress
  if (Array.isArray(statusLbIngress) && statusLbIngress.length > 0) {
    const first = statusLbIngress[0]
    return first?.ip || first?.hostname
  }
  const specExternalIps = obj?.spec?.externalIPs || obj?.spec?.external_i_ps
  if (Array.isArray(specExternalIps) && specExternalIps.length > 0) {
    return String(specExternalIps[0])
  }
  return undefined
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
    type: spec?.type ?? obj?.type ?? 'ClusterIP',
    cluster_ip: spec?.clusterIP ?? obj?.cluster_ip,
    external_ip: extractExternalIp(obj) ?? obj?.external_ip,
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

  if (index >= 0) items[index] = mergeWatchUpdate(items[index], normalized)
  else items.push(normalized)

  return items
}
