import { notRunningFirst, podNotRunning } from '@/utils/aiContext/podCounts'
import { buildResourceLink } from '@/utils/resourceLink'

type PodRow = Record<string, any>

interface OwnedPods {
  pods: PodRow[]
  podsEnabled: boolean
  podsLoaded: boolean
  // the server's count of the set when the window reads it a page at a time: the rows are then the page it shows
  counted?: { total: number; notRunning?: number }
}

// The pods a workload's window lists: the live list, else the describe answer's until that has some.
export function ownedDisplayPods(describe: Record<string, any> | undefined, owned: Pick<OwnedPods, 'pods' | 'podsEnabled'>): PodRow[] {
  if (owned.podsEnabled && owned.pods.length > 0) return owned.pods
  return Array.isArray(describe?.owned_pods) ? describe.owned_pods : []
}

// What the floating chat is told of those pods, each with the status the window shows. The ones that need a look come
// first so the cut keeps them; known is false until a list has answered, so a window does not claim "0 pods" it never read.
export function workloadPodsLayer(describe: Record<string, any> | undefined, owned: OwnedPods, namespace: string | undefined) {
  const pods = ownedDisplayPods(describe, owned)
  const counted = owned.podsEnabled && owned.podsLoaded ? owned.counted : undefined
  return {
    known: owned.podsLoaded || Array.isArray(describe?.owned_pods),
    total: counted ? counted.total : pods.length,
    notRunning: counted ? counted.notRunning : pods.filter(podNotRunning).length,
    pageOnly: !!counted,
    items: notRunningFirst(pods).slice(0, 20).map((p) => ({
      name: p.name,
      status: p.status,
      phase: p.phase,
      restart_count: p.restart_count,
      ready: p.ready,
      node_name: p.node_name,
      _link: namespace && p.name ? buildResourceLink('Pod', namespace, p.name) : undefined,
    })),
  }
}
