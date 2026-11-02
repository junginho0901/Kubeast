// A node's status as k8s-service writes it is kubectl's STATUS column (printNode): Ready or NotReady from the Ready
// condition, Unknown when the node has none, then ",SchedulingDisabled" when the node is cordoned
// (spec.unschedulable, not a condition).

export type NodeReadiness = 'Ready' | 'NotReady' | 'Unknown'

export const NODE_READINESS: NodeReadiness[] = ['Ready', 'NotReady', 'Unknown']

export function nodeStatusParts(status?: string | null): string[] {
  return (status ?? '').split(',').map((s) => s.trim()).filter(Boolean)
}

export function nodeReadiness(status?: string | null): NodeReadiness {
  const first = nodeStatusParts(status)[0]
  return first === 'Ready' || first === 'NotReady' ? first : 'Unknown'
}

export function nodeCordoned(status?: string | null): boolean {
  return nodeStatusParts(status).includes('SchedulingDisabled')
}

// The badge of one part, as the Nodes list draws it.
export function nodeStatusBadge(part: string): string {
  const lower = (part || '').toLowerCase().trim()
  if (lower === 'ready') return 'badge-success'
  if (lower === 'schedulingdisabled') return 'badge-warning'
  if (lower.includes('notready') || lower.includes('unknown')) return 'badge-error'
  if (lower.includes('ready')) return 'badge-success'
  return 'badge-info'
}
