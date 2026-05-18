// HTTPRoutes watch event 정규화 + 적용 helper
//
// frontend/src/pages/gateway/HTTPRoutes.tsx 의
// normalizeWatchHTTPRouteObject / applyHTTPRouteWatchEvent 추출.
// raw k8s HTTPRoute object 를 API list 형태 (HTTPRouteInfo) 로 정규화 —
// spec.rules/parentRefs/hostnames + status.parents.conditions 순회해서
// Accepted/ResolvedRefs 판정 + backend_refs_count 합산.

import { mergeWatchUpdate } from '@/services/mergeWatchUpdate'
import type { HTTPRouteInfo } from '@/services/api'

export function normalizeWatchHTTPRouteObject(obj: any): HTTPRouteInfo {
  if (
    typeof obj?.name === 'string'
    && typeof obj?.namespace === 'string'
    && Object.prototype.hasOwnProperty.call(obj, 'rule_count')
  ) {
    return {
      ...obj,
      hostnames: Array.isArray(obj.hostnames) ? obj.hostnames : [],
      parent_refs: Array.isArray(obj.parent_refs) ? obj.parent_refs : [],
      rules: Array.isArray(obj.rules) ? obj.rules : [],
      parents: Array.isArray(obj.parents) ? obj.parents : [],
      conditions: Array.isArray(obj.conditions) ? obj.conditions : [],
      labels: obj.labels || {},
      annotations: obj.annotations || {},
      finalizers: Array.isArray(obj.finalizers) ? obj.finalizers : [],
    } as HTTPRouteInfo
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}

  const rules = Array.isArray(spec?.rules) ? spec.rules : []
  const parentRefs = Array.isArray(spec?.parentRefs) ? spec.parentRefs : []
  const parents = Array.isArray(status?.parents) ? status.parents : []

  let backendRefsCount = 0
  for (const rule of rules) {
    const refs = Array.isArray(rule?.backendRefs) ? rule.backendRefs : []
    backendRefsCount += refs.length
  }

  const conditions: Array<Record<string, any>> = []
  for (const parent of parents) {
    const parentConditions = Array.isArray(parent?.conditions) ? parent.conditions : []
    for (const condition of parentConditions) {
      if (condition && typeof condition === 'object') {
        conditions.push(condition)
      }
    }
  }

  const accepted = conditions.some((c) => String(c?.type) === 'Accepted' && String(c?.status).toLowerCase() === 'true')
  const resolvedRefs = conditions.some((c) => String(c?.type) === 'ResolvedRefs' && String(c?.status).toLowerCase() === 'true')

  const trueCondition = conditions.find((c) => String(c?.status).toLowerCase() === 'true')
  const falseCondition = conditions.find((c) => String(c?.status).toLowerCase() === 'false')
  const statusText = accepted
    ? 'Accepted'
    : resolvedRefs
      ? 'ResolvedRefs'
      : trueCondition?.type
        ? String(trueCondition.type)
        : falseCondition?.type
          ? `${String(falseCondition.type)}(False)`
          : 'Unknown'

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    hostnames: Array.isArray(spec?.hostnames) ? spec.hostnames : [],
    parent_refs: parentRefs,
    rules,
    parents,
    rule_count: rules.length,
    parent_refs_count: parentRefs.length,
    backend_refs_count: backendRefsCount,
    status: statusText,
    accepted,
    resolved_refs: resolvedRefs,
    conditions,
    labels: metadata?.labels ?? obj?.labels ?? {},
    annotations: metadata?.annotations ?? obj?.annotations ?? {},
    finalizers: Array.isArray(metadata?.finalizers) ? metadata.finalizers : (obj?.finalizers || []),
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
    api_version: obj?.apiVersion ?? obj?.api_version ?? null,
  }
}

export function applyHTTPRouteWatchEvent(
  prev: HTTPRouteInfo[] | undefined,
  event: { type?: string; object?: any },
): HTTPRouteInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchHTTPRouteObject(obj)
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
