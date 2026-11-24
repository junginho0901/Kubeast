// The pods behind a Service and the PromQL matcher that names them, for the drawer's "Backend Pod Resource Usage".

import { escapeRegex, promString } from '@/utils/promString'

type Endpoint = { ready?: boolean; target_ref?: { kind?: string; name?: string; namespace?: string } | null }

// The pods of the Service's ready endpoints, each once, sorted: the describe answer's endpoints name the Pod each
// address points at (a dual-stack endpoint names it twice); one of another namespace is not summed with this one's.
export function backendPodNames(endpoints: unknown, namespace: string): string[] {
  if (!Array.isArray(endpoints)) return []
  const names = new Set<string>()
  for (const e of endpoints as Endpoint[]) {
    const ref = e?.target_ref
    if (!e?.ready || ref?.kind !== 'Pod' || !ref.name) continue
    if (ref.namespace && ref.namespace !== namespace) continue
    names.add(ref.name)
  }
  return [...names].sort()
}

// A regular expression that matches these names and no other: each escaped, and the names that share the part before
// their last "-" (a workload's pods) written once with their ends grouped, so a pod of a Deployment costs its suffix.
// Prometheus anchors it at both ends. The query writes it with promString.
export function podNamesPattern(names: string[]): string {
  const groups = new Map<string, string[]>()
  for (const name of [...new Set(names)].sort()) {
    const cut = name.lastIndexOf('-')
    const head = cut > 0 ? name.slice(0, cut + 1) : ''
    const tails = groups.get(head) ?? []
    tails.push(cut > 0 ? name.slice(cut + 1) : name)
    groups.set(head, tails)
  }
  return [...groups].map(([head, tails]) => (tails.length === 1 ? escapeRegex(head + tails[0]) : `${escapeRegex(head)}(${tails.map(escapeRegex).join('|')})`)).join('|')
}

// The longest pattern, written into a URL, that one query carries: the gateway takes a request line of 8 KiB (nginx's
// default), and the rest of the query and the address take less than the remainder.
export const POD_PATTERN_URL_MAX = 6000

// The pattern is measured as the query's PromQL string writes it, without its quotes, as k8s-service's
// backendPodPatterns measures it.
export const patternFitsOneQuery = (pattern: string): boolean => encodeURIComponent(promString(pattern).slice(1, -1)).length <= POD_PATTERN_URL_MAX
