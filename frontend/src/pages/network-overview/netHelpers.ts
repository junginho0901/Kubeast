// Network 페이지의 순수 helper 함수 모음 (label selector / network policy peer / port 표시)
//
// frontend/src/pages/Network.tsx 의 상단 6 함수를 추출. JSX 없이 데이터 변환만.
// renderEndpointTargets 는 JSX 를 포함해 별도 컴포넌트 (EndpointTargets.tsx) 로 분리.

import type { NetworkPolicyInfo, PodInfo } from '@/services/api'

export function buildLabelSelector(selector: Record<string, string> | undefined | null): string | undefined {
  if (!selector) return undefined
  const entries = Object.entries(selector).filter(([k, v]) => k && v)
  if (entries.length === 0) return undefined
  return entries.map(([k, v]) => `${k}=${v}`).join(',')
}

export function isNumeric(value: string): boolean {
  return /^[0-9]+$/.test(value)
}

export function podMatchesNetworkPolicy(pod: PodInfo, policy: NetworkPolicyInfo): boolean {
  const labels = pod.labels || {}
  const sel = policy.pod_selector || { match_labels: {}, match_expressions: [] }

  const matchLabels = sel.match_labels || {}
  for (const [k, v] of Object.entries(matchLabels)) {
    if (labels[k] !== v) return false
  }

  for (const expr of sel.match_expressions || []) {
    const key = expr.key ?? ''
    const op = (expr.operator ?? '').toLowerCase()
    const values = expr.values ?? []
    const hasKey = Object.prototype.hasOwnProperty.call(labels, key)
    const value = labels[key]

    if (op === 'in') {
      if (!hasKey) return false
      if (!values.includes(value)) return false
      continue
    }
    if (op === 'notin') {
      if (!hasKey) continue
      if (values.includes(value)) return false
      continue
    }
    if (op === 'exists') {
      if (!hasKey) return false
      continue
    }
    if (op === 'doesnotexist') {
      if (hasKey) return false
      continue
    }

    // Unknown operator -> be safe and mark as non-match
    return false
  }

  return true
}

export function selectorToInline(
  selector:
    | {
        match_labels: Record<string, string>
        match_expressions?: Array<{
          key?: string | null
          operator?: string | null
          values?: string[] | null
        }>
      }
    | undefined
    | null,
  emptyMeaning: string
): string {
  const labels = selector?.match_labels || {}
  const expressions = selector?.match_expressions || []

  const labelEntries = Object.entries(labels)
  const expressionEntries = expressions
    .map((e) => {
      const key = e.key ?? ''
      const op = e.operator ?? ''
      const values = Array.isArray(e.values) ? e.values.join(',') : ''
      if (!key && !op) return null
      if (values) return `${key} ${op} (${values})`
      return `${key} ${op}`.trim()
    })
    .filter(Boolean) as string[]

  if (labelEntries.length === 0 && expressionEntries.length === 0) return emptyMeaning

  const parts: string[] = []
  if (labelEntries.length > 0) parts.push(labelEntries.map(([k, v]) => `${k}=${v}`).join(', '))
  if (expressionEntries.length > 0) parts.push(expressionEntries.join(', '))
  return parts.join(' · ')
}

export function formatPeer(peer: any): string {
  if (!peer) return '(unknown)'
  if (peer.ip_block?.cidr) {
    const except = Array.isArray(peer.ip_block.except) && peer.ip_block.except.length > 0 ? ` except=${peer.ip_block.except.join(',')}` : ''
    return `ipBlock ${peer.ip_block.cidr}${except}`
  }
  const ns = peer.namespace_selector ? selectorToInline(peer.namespace_selector, 'all namespaces') : null
  const pod = peer.pod_selector ? selectorToInline(peer.pod_selector, 'all pods') : null
  if (ns && pod) return `nsSel(${ns}) podSel(${pod})`
  if (ns) return `nsSel(${ns})`
  if (pod) return `podSel(${pod})`
  return '(all)'
}

export function formatPorts(ports: any[] | undefined): string {
  if (!Array.isArray(ports) || ports.length === 0) return '(all ports)'
  return ports
    .map((p) => {
      const proto = p.protocol || 'TCP'
      const port = p.port || '*'
      const end = p.end_port ? `-${p.end_port}` : ''
      return `${proto} ${port}${end}`
    })
    .join(', ')
}
