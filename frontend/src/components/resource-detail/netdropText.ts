import type { NetdropPeer, NetdropResult } from '@/services/api/types'
import type { NetpolCheckInitial, OtherKind } from './NetworkPolicyCheckModal'

// Words and decisions for the drawer's "Network Drops" (NetworkDrops).

export interface DropRow extends NetdropPeer {
  direction: 'incoming' | 'outgoing'
}

// rows lists both sides' peers, the most drops first.
export function rows(res: NetdropResult): DropRow[] {
  const all: DropRow[] = [
    ...(res.incoming.peers ?? []).map((p) => ({ ...p, direction: 'incoming' as const })),
    ...(res.outgoing.peers ?? []).map((p) => ({ ...p, direction: 'outgoing' as const })),
  ]
  return all.sort((a, b) => b.count - a.count)
}

// peerLabel names the other end the shortest clear way: its workload or pod (with the namespace when it
// differs), the namespace alone (a redacted peer), or '' when the metric did not name it.
export function peerLabel(p: NetdropPeer, namespace: string): string {
  const name = p.workload ? (p.kind ? `${p.kind}/${p.workload}` : p.workload) : p.pod
  if (name) return p.namespace && p.namespace !== namespace ? `${p.namespace}/${name}` : name
  return p.namespace ?? ''
}

const CHECK_KINDS: Record<string, OtherKind> = { Deployment: 'deployment', StatefulSet: 'statefulset', DaemonSet: 'daemonset' }

// checkInitial fills the NetworkPolicy check for a policy drop: the peer (its workload when the check knows the
// kind, else its pod) and the direction from the drawer's side. No port: the check covers every declared port.
export function checkInitial(r: DropRow): NetpolCheckInitial | null {
  if (r.reason !== 'POLICY_DENIED' || !r.namespace) return null
  const outgoing = r.direction === 'outgoing'
  if (r.workload && r.kind && CHECK_KINDS[r.kind]) return { outgoing, kind: CHECK_KINDS[r.kind], namespace: r.namespace, name: r.workload }
  if (r.pod) return { outgoing, kind: 'pod', namespace: r.namespace, name: r.pod }
  return null
}
