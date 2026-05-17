// NetworkPolicy watch event 정규화 + 적용 helper
//
// frontend/src/pages/network/NetworkPolicies.tsx 의 normalizeSelector /
// normalizePeer / normalizePorts (모듈 내부 helper) +
// normalizeWatchNetworkPolicyObject / applyNetworkPolicyWatchEvent 추출.
// raw k8s NetworkPolicy object 를 API list 형태 (NetworkPolicyInfo) 로 정규화 —
// spec.podSelector + spec.policyTypes + ingress/egress rules + default_deny
// 판정 + selects_all_pods 판정 + selector matchLabels/matchExpressions
// camelCase/snake_case 둘 다 지원.

import { mergeWatchUpdate } from '@/services/mergeWatchUpdate'
import type { NetworkPolicyInfo } from '@/services/api'

function normalizeSelector(raw: any): NetworkPolicyInfo['pod_selector'] {
  if (!raw) return { match_labels: {}, match_expressions: [] }
  const matchLabels = raw?.match_labels || raw?.matchLabels || {}
  const matchExpressions = raw?.match_expressions || raw?.matchExpressions || []
  return {
    match_labels: { ...matchLabels },
    match_expressions: Array.isArray(matchExpressions)
      ? matchExpressions.map((expr: any) => ({
          key: expr?.key,
          operator: expr?.operator,
          values: Array.isArray(expr?.values) ? expr.values : null,
        }))
      : [],
  }
}

function normalizePeer(peer: any) {
  const ipBlockRaw = peer?.ip_block || peer?.ipBlock
  return {
    ip_block: ipBlockRaw
      ? {
          cidr: ipBlockRaw?.cidr,
          except: Array.isArray(ipBlockRaw?.except) ? ipBlockRaw.except : [],
        }
      : null,
    namespace_selector: peer?.namespace_selector
      ? normalizeSelector(peer.namespace_selector)
      : (peer?.namespaceSelector ? normalizeSelector(peer.namespaceSelector) : null),
    pod_selector: peer?.pod_selector
      ? normalizeSelector(peer.pod_selector)
      : (peer?.podSelector ? normalizeSelector(peer.podSelector) : null),
  }
}

function normalizePorts(ports: any[]): Array<{ protocol?: string | null; port?: string | null; end_port?: number | null }> {
  if (!Array.isArray(ports)) return []
  return ports.map((port) => ({
    protocol: port?.protocol,
    port: port?.port == null ? null : String(port.port),
    end_port: port?.end_port ?? port?.endPort ?? null,
  }))
}

export function normalizeWatchNetworkPolicyObject(obj: any): NetworkPolicyInfo {
  if (
    typeof obj?.name === 'string'
    && typeof obj?.namespace === 'string'
    && obj?.pod_selector
    && Array.isArray(obj?.policy_types)
  ) {
    return obj as NetworkPolicyInfo
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const ingress = Array.isArray(spec?.ingress)
    ? spec.ingress.map((rule: any) => ({
        from: Array.isArray(rule?.from) ? rule.from.map(normalizePeer) : [],
        ports: normalizePorts(Array.isArray(rule?.ports) ? rule.ports : []),
      }))
    : []
  const egress = Array.isArray(spec?.egress)
    ? spec.egress.map((rule: any) => ({
        to: Array.isArray(rule?.to) ? rule.to.map(normalizePeer) : [],
        ports: normalizePorts(Array.isArray(rule?.ports) ? rule.ports : []),
      }))
    : []
  const policyTypes = Array.isArray(spec?.policyTypes)
    ? spec.policyTypes
    : (Array.isArray(spec?.policy_types) ? spec.policy_types : [])

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    pod_selector: normalizeSelector(spec?.podSelector ?? spec?.pod_selector),
    selects_all_pods: Object.keys(spec?.podSelector?.matchLabels || spec?.pod_selector?.match_labels || {}).length === 0
      && ((spec?.podSelector?.matchExpressions || spec?.pod_selector?.match_expressions || []).length === 0),
    policy_types: policyTypes,
    default_deny_ingress: policyTypes.includes('Ingress') && ingress.length === 0,
    default_deny_egress: policyTypes.includes('Egress') && egress.length === 0,
    ingress_rules: ingress.length,
    egress_rules: egress.length,
    ingress,
    egress,
    labels: metadata?.labels || {},
    annotations: metadata?.annotations || {},
    finalizers: metadata?.finalizers || [],
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
  }
}

export function applyNetworkPolicyWatchEvent(
  prev: NetworkPolicyInfo[] | undefined,
  event: { type?: string; object?: any },
): NetworkPolicyInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchNetworkPolicyObject(obj)
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
