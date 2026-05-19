// Gateways watch event 정규화 + 적용 helper
//
// frontend/src/pages/gateway/Gateways.tsx 의
// normalizeWatchGatewayObject / applyGatewayWatchEvent 추출.
// raw k8s Gateway (Gateway API gateway.networking.k8s.io/v1) object 를
// API list 형태 (GatewayInfo) 로 정규화 — spec.listeners 카운트 + status.listeners
// 의 attachedRoutes (camelCase/snake_case 둘 다) 합산 + status.addresses +
// status.conditions 기반 Programmed/Accepted 판정.

import { mergeWatchUpdate } from '@/services/mergeWatchUpdate'
import type { GatewayInfo } from '@/services/api'
import { inferGatewayStatus } from './gatewayHelpers'

export function normalizeWatchGatewayObject(obj: any): GatewayInfo {
  if (
    typeof obj?.name === 'string'
    && typeof obj?.namespace === 'string'
    && typeof obj?.listeners_count === 'number'
  ) {
    return {
      ...obj,
      listeners_count: Number(obj.listeners_count || 0),
      attached_routes: Number(obj.attached_routes || 0),
      addresses_count: Number(obj.addresses_count || 0),
      listeners: Array.isArray(obj.listeners) ? obj.listeners : [],
      status_listeners: Array.isArray(obj.status_listeners) ? obj.status_listeners : [],
      addresses: Array.isArray(obj.addresses) ? obj.addresses : [],
      conditions: Array.isArray(obj.conditions) ? obj.conditions : [],
      labels: obj.labels || {},
      annotations: obj.annotations || {},
      finalizers: Array.isArray(obj.finalizers) ? obj.finalizers : [],
    } as GatewayInfo
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}
  const listeners = Array.isArray(spec?.listeners) ? spec.listeners : []
  const statusListeners = Array.isArray(status?.listeners) ? status.listeners : []
  const addresses = Array.isArray(status?.addresses) ? status.addresses : []
  const conditions = Array.isArray(status?.conditions) ? status.conditions : []
  const attachedRoutes = statusListeners.reduce((sum: number, item: any) => {
    const value = Number(item?.attachedRoutes || item?.attached_routes || 0)
    return Number.isFinite(value) ? sum + value : sum
  }, 0)

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    gateway_class_name: spec?.gatewayClassName ?? obj?.gateway_class_name ?? null,
    listeners_count: listeners.length,
    attached_routes: attachedRoutes,
    addresses_count: addresses.length,
    status: inferGatewayStatus(conditions),
    programmed: conditions.some((c: any) => String(c?.type) === 'Programmed' && String(c?.status).toLowerCase() === 'true'),
    accepted: conditions.some((c: any) => String(c?.type) === 'Accepted' && String(c?.status).toLowerCase() === 'true'),
    listeners,
    status_listeners: statusListeners,
    addresses,
    conditions,
    labels: metadata?.labels || {},
    annotations: metadata?.annotations || {},
    finalizers: metadata?.finalizers || [],
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
    api_version: obj?.apiVersion ?? obj?.api_version ?? null,
  }
}

export function applyGatewayWatchEvent(
  prev: GatewayInfo[] | undefined,
  event: { type?: string; object?: any },
): GatewayInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchGatewayObject(obj)
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
