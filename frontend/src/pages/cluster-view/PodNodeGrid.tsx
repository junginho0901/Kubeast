import { Box, Loader2, Search, Server } from 'lucide-react'
import type { PodInfo } from '@/services/api'
import { getPodHealth, getHealthIcon } from './podHealth'
import { useClusterView } from './ClusterViewContext'
import { pickMainContainer, podToDetail } from './types'

// 노드별로 그룹화된 Pod card 그리드 + 검색 결과 정보 / no-results / no-pods empty state.
// Pod 카드 클릭 → detail modal open + Logs 탭 + 메인 컨테이너 자동 선택.
// 우클릭 → context menu (delete 권한 있을 때만).

interface Props {
  sortedNodeEntries: Array<[string, PodInfo[]]>
  filteredPods: PodInfo[]
  allPodsLen: number
  isLoading: boolean
  canDeletePod: boolean
  allPods: PodInfo[] | undefined
}

export function PodNodeGrid({ sortedNodeEntries, filteredPods, allPodsLen, isLoading, canDeletePod, allPods }: Props) {
  const {
    tr,
    searchQuery,
    deletingPods,
    setSelectedPod,
    setSelectedContainer,
    selectTab,
    setContainerSearchQuery,
    setPodContextMenu,
  } = useClusterView()

  const handlePodClick = (pod: any) => {
    const detail = podToDetail(pod)
    setSelectedPod(detail)
    setSelectedContainer(pickMainContainer(pod))
    setContainerSearchQuery('')
    selectTab('logs')
  }

  const handlePodContextMenu = (event: React.MouseEvent, pod: PodInfo) => {
    if (!canDeletePod) return
    event.preventDefault()
    setPodContextMenu({ x: event.clientX, y: event.clientY, pod })
  }

  return (
    <div className="space-y-6">
      {searchQuery && (
        <div className="text-sm text-slate-400">
          {tr('clusterView.searchResults', 'Results')}:{' '}
          <span className="text-white font-medium">{filteredPods.length}</span>{' '}
          {tr('clusterView.countSuffix', 'items')}
          {filteredPods.length !== allPodsLen && (
            <span className="ml-2">
              {tr('clusterView.searchResultsTotal', '(out of {{count}})', { count: allPodsLen })}
            </span>
          )}
        </div>
      )}

      {searchQuery && filteredPods.length === 0 && (
        <div className="card text-center py-12">
          <Search className="w-12 h-12 text-slate-600 mx-auto mb-4" />
          <p className="text-slate-400">
            {tr('clusterView.noSearchResults', 'No pods found for "{{query}}"', { query: searchQuery })}
          </p>
        </div>
      )}

      {sortedNodeEntries.length > 0 ? (
        sortedNodeEntries.map(([nodeName, pods]) => (
          <div key={nodeName} className="card">
            <div className="flex items-center gap-3 mb-4">
              <Server className="w-6 h-6 text-cyan-400" />
              <h2 className="text-xl font-bold text-white">{nodeName}</h2>
              <span className="badge badge-secondary">
                {tr('clusterView.nodePodsCount', '{{count}} Pods', { count: pods.length })}
              </span>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
              {pods.map((pod, idx) => {
                const podKey = `${pod.namespace}/${pod.name}`
                const isDeleting = deletingPods.has(podKey)
                const health = getPodHealth(pod)
                return (
                  <button
                    key={`${pod.namespace}-${pod.name}-${idx}`}
                    onClick={() => handlePodClick(pod)}
                    onContextMenu={(event) => {
                      if (!isDeleting) handlePodContextMenu(event, pod)
                    }}
                    disabled={isDeleting}
                    className={`p-3 bg-slate-700 rounded-lg transition-colors text-left ${
                      isDeleting ? 'opacity-60 cursor-not-allowed' : 'hover:bg-slate-600'
                    }`}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <Box className="w-4 h-4 text-slate-400 flex-shrink-0" />
                      {isDeleting ? (
                        <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />
                      ) : (
                        getHealthIcon(health.level, health.reason)
                      )}
                    </div>
                    <div className="text-sm font-medium text-white truncate" title={pod.name}>
                      {pod.name}
                    </div>
                    <div className="text-xs text-slate-400 mt-1">{pod.namespace}</div>
                    <div className={`text-xs mt-1 min-h-[16px] ${isDeleting ? 'text-amber-400' : 'text-slate-300'}`}>
                      {isDeleting ? tr('clusterView.podDeleting', 'Deleting...') : health.reason}
                    </div>
                    <div className="text-xs text-yellow-400 mt-1 min-h-[16px]">
                      {pod.restart_count > 0 &&
                        tr('clusterView.restarts', 'Restarts: {{count}}', { count: pod.restart_count })}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        ))
      ) : (
        !searchQuery && !isLoading && allPods !== undefined && (
          <div className="card text-center py-12">
            <Box className="w-12 h-12 text-slate-600 mx-auto mb-4" />
            <p className="text-slate-400">{tr('clusterView.noPods', 'No pods found')}</p>
          </div>
        )
      )}
    </div>
  )
}
