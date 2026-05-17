// NetworkPolicies 페이지의 helper 함수 및 type
//
// frontend/src/pages/network/NetworkPolicies.tsx 의 parseAgeSeconds / formatAge /
// formatPolicyTypes / formatSelector / formatDefaultDeny / networkPolicyToRawJson
// + SortKey 타입 추출. 순수 함수 + 타입 정의.

import type { NetworkPolicyInfo } from '@/services/api'

export type SortKey =
  | null
  | 'name'
  | 'namespace'
  | 'podSelector'
  | 'types'
  | 'ingressRules'
  | 'egressRules'
  | 'defaultDeny'
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

export function formatPolicyTypes(policy: NetworkPolicyInfo): string {
  const types = Array.isArray(policy.policy_types) ? policy.policy_types : []
  return types.length > 0 ? types.join(', ') : '-'
}

export function formatSelector(policy: NetworkPolicyInfo): string {
  const selector = policy.pod_selector || { match_labels: {}, match_expressions: [] }
  const labels = Object.entries(selector.match_labels || {})
    .map(([key, value]) => `${key}=${value}`)
  const expressions = (selector.match_expressions || []).map((expr) => {
    const key = expr?.key || '-'
    const operator = expr?.operator || '-'
    const values = Array.isArray(expr?.values) && expr.values.length > 0 ? ` (${expr.values.join(',')})` : ''
    return `${key} ${operator}${values}`
  })
  const all = [...labels, ...expressions]
  if (all.length === 0) return '*'
  return all.join(', ')
}

export function formatDefaultDeny(policy: NetworkPolicyInfo): string {
  const items: string[] = []
  if (policy.default_deny_ingress) items.push('Ingress')
  if (policy.default_deny_egress) items.push('Egress')
  return items.length > 0 ? items.join(' + ') : '-'
}

export function networkPolicyToRawJson(policy: NetworkPolicyInfo): Record<string, unknown> {
  const toSelector = (selector?: {
    match_labels: Record<string, string>
    match_expressions: Array<{ key?: string | null; operator?: string | null; values?: string[] | null }>
  } | null) => ({
    matchLabels: selector?.match_labels || {},
    matchExpressions: Array.isArray(selector?.match_expressions)
      ? selector.match_expressions.map((expr) => ({
          key: expr?.key,
          operator: expr?.operator,
          values: expr?.values || [],
        }))
      : [],
  })

  const toPeer = (peer: any) => ({
    ipBlock: peer?.ip_block ? { cidr: peer.ip_block.cidr, except: peer.ip_block.except || [] } : undefined,
    namespaceSelector: peer?.namespace_selector ? toSelector(peer.namespace_selector) : undefined,
    podSelector: peer?.pod_selector ? toSelector(peer.pod_selector) : undefined,
  })

  const toPort = (port: any) => ({
    protocol: port?.protocol,
    port: port?.port,
    endPort: port?.end_port,
  })

  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: policy.name,
      namespace: policy.namespace,
      creationTimestamp: policy.created_at,
      labels: policy.labels || {},
      annotations: policy.annotations || {},
      finalizers: policy.finalizers || [],
    },
    spec: {
      podSelector: toSelector(policy.pod_selector),
      policyTypes: policy.policy_types || [],
      ingress: (policy.ingress || []).map((rule) => ({
        from: (rule.from || []).map(toPeer),
        ports: (rule.ports || []).map(toPort),
      })),
      egress: (policy.egress || []).map((rule) => ({
        to: (rule.to || []).map(toPeer),
        ports: (rule.ports || []).map(toPort),
      })),
    },
  }
}
