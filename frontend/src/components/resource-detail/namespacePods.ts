import { podWindowBadge } from '@/pages/dashboard/modals/podWindowBadge'
import { buildResourceLink } from '@/utils/resourceLink'
import { notRunningFirst, podCounts } from '@/utils/aiContext/podCounts'

export interface NamespacePodRow {
  name: string
  status?: string | null
  phase?: string | null
  ready?: string | null
  restart_count?: number | null
  node_name?: string | null
  created_at?: string | null
}

// The Namespace window's Pods table says what the Pods list says of a pod, in its colour; the phase stays on hover.
export function namespacePodBadge(pod: NamespacePodRow): { text: string; badge: string; title?: string } {
  const { text, badge, title } = podWindowBadge(pod)
  return { text, badge, title }
}

// What the floating chat is told of the table: its words and counts over every pod, the ones that need a look first.
export function namespacePodsLayer(pods: NamespacePodRow[], namespace: string) {
  const { notRunning, byPhase, byStatus } = podCounts(pods)
  return {
    notRunning,
    byPhase,
    byStatus,
    items: notRunningFirst(pods).slice(0, 20).map((p) => ({
      name: p.name,
      status: p.status,
      phase: p.phase,
      ready: p.ready,
      restart_count: p.restart_count,
      node_name: p.node_name,
      created_at: p.created_at,
      _link: buildResourceLink('Pod', namespace, p.name),
    })) as Array<Record<string, unknown>>,
  }
}
