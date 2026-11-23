import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { usePermission } from '@/hooks/usePermission'
import { useCanExecPod } from '@/hooks/useCanCreate'
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
import { openPodWindow, podReadState, usePodDetailRead } from './podDetailRead'

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
    setSelectedPod, setExecContainer, setSelectedContainer, setContainerSearchQuery,
    activeTab, selectedContainer, execContainer,
    selectTab,
    closeContextMenu, openDeleteModal, closeDeleteModal,
  } = useClusterView()

  const { has } = usePermission()
  // the Exec tab and the box menu's Exec ask what the Pods drawer asks, each for its own pod
  const canExec = useCanExecPod(selectedPod?.namespace, selectedPod?.name)
  const canExecMenuPod = useCanExecPod(podContextMenu?.pod.namespace, podContextMenu?.pod.name)
  const canDeletePod = has('resource.pod.delete')

  // The search goes to the server after a pause (it counts every pod; the page holds only those on screen).
  const [search, setSearch] = useState('')
  useEffect(() => {
    const id = setTimeout(() => setSearch(searchQuery.trim()), 250)
    return () => clearTimeout(id)
  }, [searchQuery])

  // Data queries
  const { namespaces, summary, nodes, isLoading } = useClusterPodsQuery({ selectedNamespace, search })
  const { manifest, describeData, describeError, podRead } = usePodDetailQueries({ selectedPod, showManifest, showDescribe })
  // a window opened from a box's row reads the pod before it shows its containers
  usePodDetailRead({ selectedPod, read: podRead, choice: { activeTab, selectedContainer, execContainer }, setSelectedPod, setSelectedContainer, setExecContainer })

  // AI floating widget snapshot
  useClusterAIContext({ nodes, summary, selectedNamespace, search })

  // Derived: the node boxes and map cells in order
  const entries = useClusterDerived({ summary, nodes, search })

  // 4 useEffects (ESC, context-menu auto-close, outside-click 2개)
  useClusterEffects()

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
          entries={entries}
          matched={summary?.total ?? 0}
          all={summary?.all ?? 0}
          isLoading={isLoading}
          canDeletePod={canDeletePod}
          nodeList={nodes}
        />
      )}

      <PodContextMenu
        menu={podContextMenu}
        canExec={canExecMenuPod}
        onClose={closeContextMenu}
        onExec={(pod) => openPodWindow(pod, 'exec', { setSelectedPod, setSelectedContainer, setContainerSearchQuery, setExecContainer, selectTab })}
        onDelete={openDeleteModal}
      />

      <PodDetailModal canExec={canExec} manifest={manifest} describeData={describeData} describeError={describeError} podRead={podReadState(selectedPod, podRead)} />

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
