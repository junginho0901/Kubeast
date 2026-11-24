import { useMemo } from 'react'
import { Box, X } from 'lucide-react'
import { ModalOverlay } from '@/components/ModalOverlay'
import { useAIContext } from '@/hooks/useAIContext'
import { PodDetailTabs } from './PodDetailTabs'
import { PodDetailTabBody } from './PodDetailTabBody'
import { useClusterView } from './ClusterViewContext'
import { podWindowLayer } from './podWindowLayer'
import type { PodReadShown } from './podDetailRead'

// Pod 상세 모달 — 헤더 / 탭 바 / 탭 본문 3 영역.
// selectedPod 가 없으면 mount 안 함.

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

  const reading = podRead === 'reading'
  const layer = useMemo(
    () => (selectedPod ? podWindowLayer(selectedPod, activeTab, { describe: describeData, manifest, reading }) : null),
    [selectedPod, activeTab, describeData, manifest, reading],
  )
  useAIContext(layer, [layer])

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
