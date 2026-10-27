import type { NetflowEnd, NetflowGroup } from '@/services/api/types'
import type { NetpolCheckInitial, OtherKind } from './NetworkPolicyCheckModal'

// Words and decisions for the drawer's "Recent Flows" (NetworkFlows).

export interface FlowSelf {
  kind: string
  namespace: string
  name: string
}

// isSelf: this end is the pod, or one of the workload's pods, the drawer shows. Calico names a pod set
// "<generateName>*", and the API server names such a pod generateName plus five random characters.
export function isSelf(e: NetflowEnd, self: FlowSelf): boolean {
  if (e.namespace !== self.namespace) return false
  if (self.kind === 'Pod') {
    if (e.pod === self.name) return true
    const set = e.pod?.endsWith('*') ? e.pod.slice(0, -1) : ''
    return set !== '' && self.name.length === set.length + 5 && self.name.startsWith(set)
  }
  return e.workload?.kind === self.kind && e.workload?.name === self.name
}

// endLabel names an end the shortest clear way: its workload or pod (with the namespace when it differs), or its address.
export function endLabel(e: NetflowEnd, namespace: string): string {
  const name = e.workload ? `${e.workload.kind}/${e.workload.name}` : e.pod
  if (name) return e.namespace && e.namespace !== namespace ? `${e.namespace}/${name}` : name
  if (e.namespace) return e.ip ? `${e.namespace} (${e.ip})` : e.namespace
  if (e.names?.length) return e.ip ? `${e.names[0]} (${e.ip})` : e.names[0]
  return e.ip || '-'
}

export function policyRefs(g: NetflowGroup): { allowed: string[]; denied: string[] } {
  const name = (p: { namespace?: string; name: string }) => (p.namespace ? `${p.namespace}/${p.name}` : p.name)
  const p = g.policies
  return {
    allowed: [...(p?.egress_allowed_by ?? []), ...(p?.ingress_allowed_by ?? [])].map(name),
    denied: [...(p?.egress_denied_by ?? []), ...(p?.ingress_denied_by ?? [])].map(name),
  }
}

const CHECK_KINDS: Record<string, OtherKind> = { Deployment: 'deployment', StatefulSet: 'statefulset', DaemonSet: 'daemonset' }

// checkInitial fills the NetworkPolicy check for a connection: the other end (its workload when the check
// knows the kind, else the pod, else the address), the destination port and the direction from the drawer's side.
export function checkInitial(g: NetflowGroup, self: FlowSelf): NetpolCheckInitial | null {
  const incoming = isSelf(g.destination, self)
  if (!incoming && !isSelf(g.source, self)) return null
  const other = incoming ? g.source : g.destination
  const port = g.destination.port ? String(g.destination.port) : undefined
  const protocol = g.protocol && ['TCP', 'UDP', 'SCTP'].includes(g.protocol) ? g.protocol : undefined
  const base = { outgoing: !incoming, port, protocol }
  if (other.workload && CHECK_KINDS[other.workload.kind] && other.namespace) {
    return { ...base, kind: CHECK_KINDS[other.workload.kind], namespace: other.namespace, name: other.workload.name }
  }
  if (other.pod && other.namespace) return { ...base, kind: 'pod', namespace: other.namespace, name: other.pod }
  if (other.ip) return { ...base, kind: 'ip', ip: other.ip }
  return null
}
