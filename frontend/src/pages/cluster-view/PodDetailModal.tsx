import { Box, X } from 'lucide-react'
import { ModalOverlay } from '@/components/ModalOverlay'
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
  const { selectedPod, closeDetailModal } = useClusterView()

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
