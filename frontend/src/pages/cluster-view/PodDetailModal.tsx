import { Box, X } from 'lucide-react'
import { ModalOverlay } from '@/components/ModalOverlay'
import { useAIContext } from '@/hooks/useAIContext'
import { buildResourceLink } from '@/utils/resourceLink'
import { PodDetailTabs } from './PodDetailTabs'
import { PodDetailTabBody } from './PodDetailTabBody'
import { useClusterView } from './ClusterViewContext'

// Pod 상세 모달 — 헤더 / 탭 바 / 탭 본문 3 영역.
// selectedPod 가 없으면 mount 안 함.

interface Props {
  isAdmin: boolean
  manifest: string | undefined
  describeData: any
}

export function PodDetailModal({ isAdmin, manifest, describeData }: Props) {
  const { selectedPod, closeDetailModal, activeTab } = useClusterView()

  useAIContext(selectedPod ? {
    source: 'PodDetailModal',
    summary: `Pod ${selectedPod.name} (${selectedPod.namespace}) 상세 — ${activeTab} 탭`,
    data: {
      kind: 'Pod', name: selectedPod.name, namespace: selectedPod.namespace,
      _link: buildResourceLink('Pod', selectedPod.namespace, selectedPod.name),
      node: selectedPod.node, status: selectedPod.status, phase: selectedPod.phase, restart_count: selectedPod.restart_count,
      created_at: selectedPod.created_at,
      containers: selectedPod.containers.map((c) => ({ name: c.name, image: c.image, ready: c.ready, state: c.state, restart_count: c.restart_count })),
      describe: activeTab === 'describe' ? describeData : undefined,
      manifest: activeTab === 'manifest' && manifest ? manifest.slice(0, 4096) : undefined,
    },
  } : null, [selectedPod, activeTab, describeData, manifest])

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
              <h2 className="text-xl font-bold text-white">{selectedPod.name}</h2>
              <p className="text-sm text-slate-400">{selectedPod.namespace}</p>
            </div>
          </div>
          <button
            onClick={closeDetailModal}
            className="p-2 hover:bg-slate-700 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-slate-400" />
          </button>
        </div>

        <PodDetailTabs isAdmin={isAdmin} />
        <PodDetailTabBody manifest={manifest} describeData={describeData} />
      </div>
    </ModalOverlay>
  )
}
