import type { NetpolPeerSummary, NetpolPortSummary, NetpolUnevaluated } from '@/services/api/types'

// Words for the NetworkPolicy view and check (NetworkPolicies, NetworkPolicyCheckModal).

export type Tr = (key: string, fallback: string, options?: Record<string, unknown>) => string

export function peerText(p: NetpolPeerSummary, tr: Tr): string {
  if (p.cidr) {
    const block = tr('netpolCheck.peer.ipBlock', 'addresses {{cidr}}', { cidr: p.cidr })
    return p.except?.length ? `${block} ${tr('netpolCheck.peer.except', '(except {{list}})', { list: p.except.join(', ') })}` : block
  }
  if (p.namespace_selector === undefined) {
    return p.pod_selector
      ? tr('netpolCheck.peer.podsHere', 'pods {{sel}} in this namespace', { sel: p.pod_selector })
      : tr('netpolCheck.peer.allPodsHere', 'every pod in this namespace')
  }
  const ns = p.namespace_selector ? tr('netpolCheck.peer.namespaces', 'namespaces {{sel}}', { sel: p.namespace_selector }) : tr('netpolCheck.peer.allNamespaces', 'every namespace')
  return p.pod_selector
    ? tr('netpolCheck.peer.podsIn', 'pods {{sel}} in {{where}}', { sel: p.pod_selector, where: ns })
    : tr('netpolCheck.peer.allPodsIn', 'every pod in {{where}}', { where: ns })
}

export function portsText(ports: NetpolPortSummary[], tr: Tr): string {
  if (ports.length === 0) return tr('netpolCheck.portsAll', 'every port')
  return ports
    .map((p) => (p.port ? `${p.protocol} ${p.port}${p.end_port ? `-${p.end_port}` : ''}` : tr('netpolCheck.portsAllOf', 'every {{protocol}} port', { protocol: p.protocol })))
    .join(', ')
}

export function unevaluatedText(list: NetpolUnevaluated[], tr: Tr): string {
  return list.map((u) => `${u.kind} (${u.group}, ${u.count < 0 ? tr('netpolCheck.countUnknown', 'count unknown') : u.count})`).join(', ')
}

export function resultLabel(result: string, tr: Tr): string {
  switch (result) {
    case 'allowed': return tr('netpolCheck.result.allowed', 'Allowed')
    case 'denied': return tr('netpolCheck.result.denied', 'Denied')
    case 'mixed': return tr('netpolCheck.result.mixed', 'Differs by port or pod')
    default: return tr('netpolCheck.result.unknown', 'Unknown')
  }
}

export function reasonText(reason: string, tr: Tr): string {
  switch (reason) {
    case 'peer': return tr('netpolCheck.reason.peer', 'the other end is not one of its peers')
    case 'port': return tr('netpolCheck.reason.port', 'the port or protocol is not in the rule')
    case 'named_port': return tr('netpolCheck.reason.namedPort', 'it names a port the destination does not declare')
    case 'no_rules': return tr('netpolCheck.reason.noRules', 'no rules: denies all')
    case 'pod_ip_block': return tr('netpolCheck.reason.podIPBlock', 'allows it only through an ipBlock that covers the pod IP; whether that applies depends on the network plugin')
    case 'namespace_labels_unknown': return tr('netpolCheck.reason.namespaceUnknown', 'selects namespaces by labels you cannot read')
    case 'same_pod': return tr('netpolCheck.note.samePod', 'A pod can always reach itself.')
    case 'host_network': return tr('netpolCheck.note.hostNetwork', 'A host-network pod: the network plugin decides.')
    case 'target_port_not_on_pod': return tr('netpolCheck.note.targetPortMissing', 'These pods do not declare the target port of the Service.')
    case 'dns_egress_denied': return tr('netpolCheck.note.dnsEgressDenied', 'The source may not reach cluster DNS (kube-dns in kube-system, UDP 53), so the Service name will not resolve; its IP still works.')
    default: return reason
  }
}

export function ruleName(policy: string, rule: number, tr: Tr): string {
  return rule < 0 ? policy : `${policy} ${tr('netpolCheck.rule', 'Rule {{n}}', { n: rule + 1 })}`
}

interface LabelSelector {
  matchLabels?: Record<string, string>
  matchExpressions?: { key: string; operator: string; values?: string[] }[]
}

// The label-selector syntax of a LabelSelector, as apimachinery writes it ("" selects everything):
// requirements sorted by key, k=v, "k in (a,b)", "k notin (a,b)", k, !k.
export function selectorText(sel: LabelSelector | undefined | null): string {
  const reqs: [string, string][] = Object.entries(sel?.matchLabels ?? {}).map(([k, v]) => [k, `${k}=${v}`])
  for (const e of sel?.matchExpressions ?? []) {
    const values = [...(e.values ?? [])].sort().join(',')
    const text = e.operator === 'In' ? `${e.key} in (${values})`
      : e.operator === 'NotIn' ? `${e.key} notin (${values})`
        : e.operator === 'DoesNotExist' ? `!${e.key}` : e.key
    reqs.push([e.key, text])
  }
  return reqs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((r) => r[1]).join(',')
}

// A NetworkPolicy peer or port of the object itself (rawJson) in the summary shape the texts take.
export function peerOf(peer: { podSelector?: LabelSelector; namespaceSelector?: LabelSelector; ipBlock?: { cidr: string; except?: string[] } }): NetpolPeerSummary {
  return {
    pod_selector: peer.podSelector ? selectorText(peer.podSelector) : undefined,
    namespace_selector: peer.namespaceSelector ? selectorText(peer.namespaceSelector) : undefined,
    cidr: peer.ipBlock?.cidr,
    except: peer.ipBlock?.except,
  }
}

export function portOf(port: { protocol?: string; port?: string | number; endPort?: number }): NetpolPortSummary {
  return { protocol: port.protocol || 'TCP', port: port.port === undefined ? undefined : String(port.port), end_port: port.endPort }
}
