import { enforceTokenBudget } from '@/utils/aiContext/tokenBudget'
import { buildResourceLink } from '@/utils/resourceLink'
import { getPodHealth } from './podHealth'
import type { DetailTab, PodDetail } from './types'

// What the pod window tells the floating chat of the pod.

// Kubernetes' own reasons are one word; a runtime may write any text there.
const REASON = /^[A-Za-z][A-Za-z0-9]{0,39}$/
const word = (reason: unknown) => (typeof reason === 'string' && REASON.test(reason) ? reason : undefined)

// Of an init container's state: which it is, its reason as one short word and its exit code. No message, not even its
// start: it is free text of up to 4 KB, and the server masks a credential only where it reads it whole.
function initState(state: any) {
  if (state?.waiting) return { waiting: { reason: word(state.waiting.reason) } }
  if (state?.terminated) return { terminated: { reason: word(state.terminated.reason), exit_code: state.terminated.exit_code } }
  return state?.running ? { running: {} } : undefined
}

// At most five, as the Pod drawer's layer gives: the ones not ready first, since State can be about one of them.
function initContainers(list: any[]) {
  return [...list.filter((c) => !c.ready), ...list.filter((c) => c.ready)].slice(0, 5).map((c) => ({
    name: c.name, ready: c.ready, restart_count: c.restart_count, restart_policy: c.restart_policy, state: initState(c.state),
  }))
}

interface Shown {
  describe?: unknown
  manifest?: string
  /** the pod's own read is on its way: containers not read yet are no containers, and a failed read says itself (DescribeFailure) */
  reading: boolean
}

export function podWindowLayer(pod: PodDetail, tab: DetailTab, { describe, manifest, reading }: Shown) {
  const answer = tab === 'describe' ? describe : undefined
  const layer = (health?: { state: string; health: string }, init_containers?: ReturnType<typeof initContainers>) => ({
    source: 'PodDetailModal',
    summary: `Pod ${pod.name} (${pod.namespace}) 상세 — ${tab} 탭`,
    data: {
      kind: 'Pod', name: pod.name, namespace: pod.namespace,
      _link: buildResourceLink('Pod', pod.namespace, pod.name),
      node: pod.node, status: pod.status, phase: pod.phase, ...health, restart_count: pod.restart_count, created_at: pod.created_at,
      containers: pod.containersKnown
        ? pod.containers.map((c) => ({ name: c.name, image: c.image, ready: c.ready, state: c.state, restart_count: c.restart_count }))
        : undefined,
      init_containers,
      containers_loading: reading || undefined,
      describe: answer,
      manifest: tab === 'manifest' && manifest ? manifest.slice(0, 4096) : undefined,
    },
  })
  const without = layer()
  if (!pod.containersKnown) return without

  // The Summary tab's State (reason) and Health (level), and the init containers unless the describe answer has them whole.
  // The token budget halves a layer's lists past its size and then drops the layer, so these go in as far as it keeps
  // every container it keeps without them: all, the ones not ready, no init container, then neither State nor Health.
  const { reason: state, level: health } = getPodHealth(pod)
  const inits = initContainers(pod.init_containers ?? [])
  const notReady = inits.filter((c) => !c.ready)
  const lists = answer ? [] : notReady.length > 0 ? [inits, notReady] : [inits]
  const kept = (l: typeof without) => (enforceTokenBudget(l).data?.containers as unknown[] | undefined)?.length ?? 0
  return [...lists, undefined].map((list) => layer({ state, health }, list)).find((l) => kept(l) >= kept(without)) ?? without
}
