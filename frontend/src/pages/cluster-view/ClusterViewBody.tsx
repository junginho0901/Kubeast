import { RefreshCw } from 'lucide-react'
import { usePermission } from '@/hooks/usePermission'
import { useClusterView } from './ClusterViewContext'
import { useClusterPodsQuery } from './hooks/useClusterPodsQuery'
import { usePodDetailQueries } from './hooks/usePodDetailQueries'
import { useClusterAIContext } from './hooks/useClusterAIContext'
import { useClusterDerived } from './hooks/useClusterDerived'
import { useClusterEffects } from './hooks/useClusterEffects'
import { usePodDelete } from './hooks/usePodDelete'
import { ClusterViewHeader } from './ClusterViewHeader'
import { PodNodeGrid } from './PodNodeGrid'
import { PodContextMenu } from './PodContextMenu'
import { PodDetailModal } from './PodDetailModal'
import { PodDeleteModal } from './PodDeleteModal'
import { podToDetail } from './types'

// ClusterView 본체 — ClusterViewProvider 안에서만 mount. 모든 hook 을 순서대로
// 호출하고 sub-component 들 render. 모든 hook 은 early-return 보다 먼저 호출.

export function ClusterViewBody() {
  const {
    tr,
    selectedNamespace,
    searchQuery,
    selectedPod,
    showManifest, showDescribe,
    podContextMenu,
    deleteTargetPod, deleteForce, setDeleteForce, deleteError, isDeletingPod,
    setSelectedPod, setExecContainer,
    selectTab,
    closeContextMenu, openDeleteModal, closeDeleteModal,
  } = useClusterView()

  const { has } = usePermission()
  const isAdmin = has('resource.pod.create')
  const canDeletePod = has('resource.pod.delete')

  // Data queries
  const { namespaces, allPods, nodes, isLoading } = useClusterPodsQuery({ selectedNamespace })
  const { manifest, describeData } = usePodDetailQueries({ selectedPod, showManifest, showDescribe })

  // AI floating widget snapshot
  useClusterAIContext({ nodes, allPods, selectedNamespace })

  // Derived: filteredPods / sortedNodeEntries
  const { filteredPods, sortedNodeEntries } = useClusterDerived({ allPods, nodes, searchQuery })

  // 5 useEffects (ESC, context-menu auto-close, outside-click 2개, deletingPods reconcile)
  useClusterEffects({ allPods })

  // Delete handler
  const { handleDeletePod } = usePodDelete()

  return (
    <div className="space-y-6">
      <ClusterViewHeader namespaces={namespaces} />

      {isLoading ? (
        <div className="flex flex-col items-center justify-center h-full min-h-[300px]">
          <RefreshCw className="w-8 h-8 text-primary-400 animate-spin mb-4" />
          <p className="text-slate-400">{tr('clusterView.loading', 'Loading data...')}</p>
        </div>
      ) : (
        <PodNodeGrid
          sortedNodeEntries={sortedNodeEntries}
          filteredPods={filteredPods}
          allPodsLen={allPods?.length || 0}
          isLoading={isLoading}
          canDeletePod={canDeletePod}
          allPods={allPods}
        />
      )}

      <PodContextMenu
        menu={podContextMenu}
        isAdmin={isAdmin}
        onClose={closeContextMenu}
        onExec={(pod) => {
          const detail = podToDetail(pod)
          setSelectedPod(detail)
          setExecContainer(detail.containers?.[0]?.name || '')
          selectTab('exec')
        }}
        onDelete={openDeleteModal}
      />

      <PodDetailModal isAdmin={isAdmin} manifest={manifest} describeData={describeData} />

      <PodDeleteModal
        pod={deleteTargetPod}
        force={deleteForce}
        error={deleteError}
        isDeleting={isDeletingPod}
        onForceChange={setDeleteForce}
        onClose={closeDeleteModal}
        onConfirm={handleDeletePod}
      />
    </div>
  )
}
