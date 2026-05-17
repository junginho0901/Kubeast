// EndpointSlice watch event 정규화 + 적용 helper
//
// frontend/src/pages/network/EndpointSlices.tsx 의
// normalizeWatchEndpointSliceObject / applyEndpointSliceWatchEvent 추출.
// raw k8s EndpointSlice object 를 API list 형태 (EndpointSliceInfo) 로 정규화 —
// metadata.labels 의 service-name / managed-by 추출, endpoints 의 targetRef +
// topology zone + conditions.ready (null=true 처리) 정규화, ports 의 appProtocol
// camelCase/snake_case 둘 다 지원.

import { mergeWatchUpdate } from '@/services/mergeWatchUpdate'
import type { EndpointSliceInfo } from '@/services/api'

export function normalizeWatchEndpointSliceObject(obj: any): EndpointSliceInfo {
  if (
    typeof obj?.name === 'string' &&
    typeof obj?.namespace === 'string' &&
    typeof obj?.endpoints_total === 'number' &&
    typeof obj?.endpoints_ready === 'number' &&
    Array.isArray(obj?.ports)
  ) {
    return {
      ...obj,
      endpoints_not_ready: typeof obj?.endpoints_not_ready === 'number'
        ? obj.endpoints_not_ready
        : Math.max((obj?.endpoints_total || 0) - (obj?.endpoints_ready || 0), 0),
    } as EndpointSliceInfo
  }

  const metadata = obj?.metadata ?? {}
  const labels = (metadata?.labels ?? {}) as Record<string, string>
  const annotations = (metadata?.annotations ?? {}) as Record<string, string>
  const rawEndpoints = Array.isArray(obj?.endpoints) ? obj.endpoints : []
  const rawPorts = Array.isArray(obj?.ports) ? obj.ports : []

  const endpoints = rawEndpoints.map((ep: any) => {
    const cond = ep?.conditions ?? {}
    const ref = ep?.targetRef ?? ep?.target_ref
    const topology = ep?.topology ?? {}
    return {
      addresses: Array.isArray(ep?.addresses) ? ep.addresses : [],
      hostname: ep?.hostname,
      node_name: ep?.nodeName || ep?.node_name,
      zone: ep?.zone || topology?.['topology.kubernetes.io/zone'] || topology?.['failure-domain.beta.kubernetes.io/zone'],
      conditions: {
        ready: cond?.ready,
        serving: cond?.serving,
        terminating: cond?.terminating,
      },
      target_ref: ref
        ? {
            kind: ref?.kind,
            name: ref?.name,
            namespace: ref?.namespace,
            uid: ref?.uid,
          }
        : null,
    }
  })

  let ready = 0
  for (const ep of endpoints) {
    const condReady = ep?.conditions?.ready
    if (condReady === true || condReady == null) ready += 1
  }

  const ports = rawPorts.map((p: any) => ({
    name: p?.name,
    port: p?.port,
    protocol: p?.protocol,
    app_protocol: p?.appProtocol || p?.app_protocol,
  }))

  const total = endpoints.length

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    service_name: labels?.['kubernetes.io/service-name'] ?? obj?.service_name,
    managed_by: labels?.['endpointslice.kubernetes.io/managed-by'] ?? obj?.managed_by,
    address_type: obj?.addressType ?? obj?.address_type,
    endpoints_total: total,
    endpoints_ready: ready,
    endpoints_not_ready: Math.max(total - ready, 0),
    ports,
    endpoints,
    labels,
    annotations,
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
  }
}

export function applyEndpointSliceWatchEvent(prev: EndpointSliceInfo[] | undefined, event: { type?: string; object?: any }): EndpointSliceInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchEndpointSliceObject(obj)
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
