// Endpoints watch event 정규화 + 적용 helper
//
// frontend/src/pages/network/Endpoints.tsx 의
// normalizeWatchEndpointObject / applyEndpointWatchEvent 추출.
// raw k8s Endpoints (legacy v1) object 를 API list 형태 (EndpointInfo) 로 정규화 —
// subsets 배열 전체 순회하여 addresses + notReadyAddresses + ports 합산,
// ports 는 (name|port|protocol) 키로 dedup, targetRef/nodeName camelCase/snake_case
// 둘 다 지원.

import { mergeWatchUpdate } from '@/services/mergeWatchUpdate'
import type { EndpointInfo } from '@/services/api'

export function normalizeWatchEndpointObject(obj: any): EndpointInfo {
  if (
    typeof obj?.name === 'string' &&
    typeof obj?.namespace === 'string' &&
    typeof obj?.ready_count === 'number' &&
    typeof obj?.not_ready_count === 'number' &&
    Array.isArray(obj?.ports)
  ) {
    return obj as EndpointInfo
  }

  const metadata = obj?.metadata ?? {}
  const subsets = Array.isArray(obj?.subsets) ? obj.subsets : []

  const readyAddresses: string[] = []
  const notReadyAddresses: string[] = []
  const readyTargets: EndpointInfo['ready_targets'] = []
  const notReadyTargets: EndpointInfo['not_ready_targets'] = []
  const ports: EndpointInfo['ports'] = []

  for (const subset of subsets) {
    for (const addr of subset?.addresses || []) {
      const ip = addr?.ip
      if (ip) readyAddresses.push(ip)
      readyTargets.push({
        ip,
        node_name: addr?.nodeName || addr?.node_name,
        target_ref: addr?.targetRef || addr?.target_ref || null,
      })
    }
    for (const addr of subset?.notReadyAddresses || subset?.not_ready_addresses || []) {
      const ip = addr?.ip
      if (ip) notReadyAddresses.push(ip)
      notReadyTargets.push({
        ip,
        node_name: addr?.nodeName || addr?.node_name,
        target_ref: addr?.targetRef || addr?.target_ref || null,
      })
    }
    for (const p of subset?.ports || []) {
      ports.push({
        name: p?.name,
        port: p?.port,
        protocol: p?.protocol,
      })
    }
  }

  const seen = new Set<string>()
  const dedupPorts = ports.filter((p) => {
    const key = `${p.name || ''}|${p.port || ''}|${p.protocol || ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    ready_count: readyAddresses.length,
    not_ready_count: notReadyAddresses.length,
    ready_addresses: readyAddresses,
    not_ready_addresses: notReadyAddresses,
    ready_targets: readyTargets,
    not_ready_targets: notReadyTargets,
    ports: dedupPorts,
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
  }
}

export function applyEndpointWatchEvent(prev: EndpointInfo[] | undefined, event: { type?: string; object?: any }): EndpointInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchEndpointObject(obj)
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
