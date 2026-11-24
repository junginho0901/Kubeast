import { Box, X } from 'lucide-react'
import { ModalOverlay } from '@/components/ModalOverlay'
import { useAIContext } from '@/hooks/useAIContext'
import { buildResourceLink } from '@/utils/resourceLink'
import { PodDetailTabs } from './PodDetailTabs'
import { PodDetailTabBody } from './PodDetailTabBody'
import { useClusterView } from './ClusterViewContext'
import { getPodHealth } from './podHealth'
import type { PodReadShown } from './podDetailRead'

// Pod 상세 모달 — 헤더 / 탭 바 / 탭 본문 3 영역.
// selectedPod 가 없으면 mount 안 함.

// The init containers as the layer gives them, at most five as the Pod drawer's: the ones not ready first, since State can
// be about one of them, and each message cut, since one may end on 4 KB, half of what a layer holds (tokenBudget).
function initContainersLayer(list: any[]) {
  const cut = (state: any) => (state?.message?.length > 300 ? { ...state, message: `${state.message.slice(0, 300)}…` } : state)
  return [...list.filter((c) => !c.ready), ...list.filter((c) => c.ready)].slice(0, 5).map((c) => ({
    name: c.name, ready: c.ready, restart_count: c.restart_count, restart_policy: c.restart_policy,
    state: c.state && { ...c.state, waiting: cut(c.state.waiting), terminated: cut(c.state.terminated) },
  }))
}

interface Props {
  /** the pod's terminal would open (useCanExecPod): the Exec tab shows */
  canExec: boolean
  manifest: string | undefined
  describeData: any
  describeError?: unknown
  /** the pod's own read of a window opened from a box's row (podDetailRead) */
  podRead?: PodReadShown
}

export function PodDetailModal({ canExec, manifest, describeData, describeError, podRead = 'none' }: Props) {
  const { selectedPod, closeDetailModal, activeTab, tr } = useClusterView()

  // containers not read yet are no containers: the layer says they are being read, and a failed read says itself
  // (DescribeFailure)
  const reading = podRead === 'reading'
  // the Summary tab's State (reason) and Health (level)
  const health = selectedPod?.containersKnown ? getPodHealth(selectedPod) : undefined
  const describe = activeTab === 'describe' ? describeData : undefined
  useAIContext(selectedPod ? {
    source: 'PodDetailModal',
    summary: `Pod ${selectedPod.name} (${selectedPod.namespace}) 상세 — ${activeTab} 탭`,
    data: {
      kind: 'Pod', name: selectedPod.name, namespace: selectedPod.namespace,
      _link: buildResourceLink('Pod', selectedPod.namespace, selectedPod.name),
      node: selectedPod.node, status: selectedPod.status, phase: selectedPod.phase, state: health?.reason, health: health?.level,
      restart_count: selectedPod.restart_count, created_at: selectedPod.created_at,
      containers: selectedPod.containersKnown
        ? selectedPod.containers.map((c) => ({ name: c.name, image: c.image, ready: c.ready, state: c.state, restart_count: c.restart_count }))
        : undefined,
      // the describe answer has them whole
      init_containers: selectedPod.containersKnown && !describe ? initContainersLayer(selectedPod.init_containers ?? []) : undefined,
      containers_loading: reading || undefined,
      describe,
      manifest: activeTab === 'manifest' && manifest ? manifest.slice(0, 4096) : undefined,
    },
  } : null, [selectedPod, activeTab, describeData, manifest, reading])

  if (!selectedPod) return null

  return (
    <ModalOverlay onClose={closeDetailModal}>
      <div
        className="bg-slate-800 rounded-lg max-w-6xl w-full h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 border-b border-slate-700 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Box className="w-6 h-6 text-primary-400" />
            <div>
              <h2 className="text-xl font-semibold text-ink">{selectedPod.name}</h2>
              <p className="text-sm text-slate-400">{selectedPod.namespace}</p>
            </div>
          </div>
          <button
            onClick={closeDetailModal}
            className="p-2 hover:bg-slate-700 rounded-lg transition-colors"
            aria-label={tr('common.close', 'Close')}
          >
            <X className="w-5 h-5 text-slate-400" />
          </button>
        </div>

        <PodDetailTabs canExec={canExec} />
        <PodDetailTabBody manifest={manifest} describeData={describeData} describeError={describeError} podRead={podRead} />
      </div>
    </ModalOverlay>
  )
}
