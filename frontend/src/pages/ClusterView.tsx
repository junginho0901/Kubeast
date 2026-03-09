import { useState, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import type { PodInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { ModalOverlay } from '@/components/ModalOverlay'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { 
  Server, 
  Box, 
  CheckCircle, 
  XCircle, 
  AlertCircle,
  RefreshCw,
  Loader2,
  Trash2,
  HelpCircle,
  X,
  ChevronDown,
  Search,
} from 'lucide-react'

export default function ClusterView() {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) => t(key, { defaultValue: fallback, ...options })
  const { open: openDetail } = useResourceDetail()
  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    retry: false,
    staleTime: 30000,
  })
  const [selectedNamespace, setSelectedNamespace] = useState<string>('all')
  const [isNamespaceDropdownOpen, setIsNamespaceDropdownOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState<string>('')
  const [podContextMenu, setPodContextMenu] = useState<{ x: number; y: number; pod: PodInfo } | null>(null)
  const [deleteTargetPod, setDeleteTargetPod] = useState<PodInfo | null>(null)
  const [deleteForce, setDeleteForce] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [isDeletingPod, setIsDeletingPod] = useState(false)
  const [deletingPods, setDeletingPods] = useState<Set<string>>(new Set())
  const namespaceDropdownRef = useRef<HTMLDivElement>(null)

  // ESC 키로 모달/메뉴 닫기
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (podContextMenu) setPodContextMenu(null)
      if (deleteTargetPod) closeDeleteModal()
    }
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('keydown', handleEscape)
    }
  }, [podContextMenu, deleteTargetPod])

  useEffect(() => {
    if (!podContextMenu) return
    const handleClose = () => setPodContextMenu(null)
    window.addEventListener('resize', handleClose)
    window.addEventListener('scroll', handleClose, true)
    return () => {
      window.removeEventListener('resize', handleClose)
      window.removeEventListener('scroll', handleClose, true)
    }
  }, [podContextMenu])

  // 네임스페이스 목록
  const { data: namespaces } = useQuery({
    queryKey: ['namespaces'],
    queryFn: () => api.getNamespaces(),
  })

  // 전체 Pod 조회
  const { data: allPods, isLoading } = useQuery({
    queryKey: ['all-pods', selectedNamespace],
    queryFn: async () => {
      const forceRefresh = true // Pod 조회는 항상 강제 갱신
      if (selectedNamespace === 'all') {
        const pods = await Promise.all(
          (namespaces || []).map(ns => api.getPods(ns.name, undefined, forceRefresh))
        )
        return pods.flat()
      } else {
        return await api.getPods(selectedNamespace, undefined, forceRefresh)
      }
    },
    enabled: !!namespaces,
  })

  useKubeWatchList({
    enabled: !!namespaces,
    queryKey: ['all-pods', selectedNamespace],
    path:
      selectedNamespace === 'all'
        ? '/api/v1/pods'
        : `/api/v1/namespaces/${selectedNamespace}/pods`,
    query: 'watch=1',
  })

  // 노드 목록 (정렬용)
  const { data: nodes } = useQuery({
    queryKey: ['nodes'],
    queryFn: () => api.getNodes(false),
  })

  // 네임스페이스 드롭다운 외부 클릭 감지
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        namespaceDropdownRef.current &&
        !namespaceDropdownRef.current.contains(event.target as Node)
      ) {
        setIsNamespaceDropdownOpen(false)
      }
    }

    if (isNamespaceDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isNamespaceDropdownOpen])

  // 검색어로 Pod 필터링
  const filteredPods = allPods?.filter(pod => {
    if (!searchQuery.trim()) return true
    const query = searchQuery.toLowerCase()
    return pod.name.toLowerCase().includes(query) || 
           pod.namespace.toLowerCase().includes(query)
  }) || []

  // 노드별로 Pod 그룹화 (필터링된 Pod 기준)
  const podsByNode = filteredPods.reduce((acc, pod) => {
    const nodeName = pod.node_name || 'Unscheduled'
    if (!acc[nodeName]) acc[nodeName] = []
    acc[nodeName].push(pod)
    return acc
  }, {} as Record<string, any[]>)

  // 노드 정렬: control-plane 먼저, 그 다음 워커 노드, 각 그룹 내에서는 이름 순
  const sortedNodeEntries = Object.entries(podsByNode).sort(([nodeA], [nodeB]) => {
    // 노드 정보 찾기
    const nodeInfoA = nodes?.find((n: any) => n.name === nodeA)
    const nodeInfoB = nodes?.find((n: any) => n.name === nodeB)
    
    // Unscheduled는 맨 뒤로
    if (nodeA === 'Unscheduled') return 1
    if (nodeB === 'Unscheduled') return -1
    
    // control-plane 역할 확인
    const isControlPlaneA = nodeInfoA?.roles?.includes('control-plane') || false
    const isControlPlaneB = nodeInfoB?.roles?.includes('control-plane') || false
    
    // control-plane이 먼저
    if (isControlPlaneA && !isControlPlaneB) return -1
    if (!isControlPlaneA && isControlPlaneB) return 1
    
    // 같은 그룹 내에서는 이름 순으로 정렬
    return nodeA.localeCompare(nodeB)
  })

  const canDeletePod = ['admin', 'write'].includes(String(me?.role || '').toLowerCase())

  const pickReason = (reasons: string[], priority: string[]) => {
    for (const p of priority) {
      if (reasons.includes(p)) return p
    }
    return reasons[0] || ''
  }

  const isCompletedReason = (reason?: string | null) => {
    if (!reason) return false
    return reason === 'Completed' || reason === 'Succeeded'
  }

  const getPodHealth = (pod: any) => {
    const phase = pod?.phase || pod?.status || 'Unknown'
    const containers = Array.isArray(pod?.containers) ? pod.containers : []
    const initContainers = Array.isArray(pod?.init_containers) ? pod.init_containers : []
    const statusReason = isCompletedReason(pod?.status_reason) ? null : pod?.status_reason
    const waitingReasons = containers
      .map((c: any) => c?.state?.waiting?.reason)
      .filter((r: any) => typeof r === 'string' && r.trim()) as string[]
    const terminatedReasons = containers
      .map((c: any) => ({
        reason: c?.state?.terminated?.reason,
        exitCode: c?.state?.terminated?.exit_code,
      }))
      .filter((r: any) => typeof r?.reason === 'string' && r.reason.trim())
      .filter((r: any) => !isCompletedReason(r.reason))
      .map((r: any) => r.reason) as string[]
    const initWaitingReasons = initContainers
      .map((c: any) => c?.state?.waiting?.reason)
      .filter((r: any) => typeof r === 'string' && r.trim()) as string[]
    const initTerminatedReasons = initContainers
      .map((c: any) => ({
        reason: c?.state?.terminated?.reason,
        exitCode: c?.state?.terminated?.exit_code,
      }))
      .filter((r: any) => typeof r?.reason === 'string' && r.reason.trim())
      .filter((r: any) => !isCompletedReason(r.reason))
      .map((r: any) => r.reason) as string[]

    const errorPriority = [
      'CrashLoopBackOff',
      'ImagePullBackOff',
      'ErrImagePull',
      'CreateContainerConfigError',
      'CreateContainerError',
      'RunContainerError',
      'ContainerCannotRun',
      'InvalidImageName',
      'ImageInspectError',
      'RegistryUnavailable',
      'ErrImageNeverPull',
      'OOMKilled',
      'Error',
    ]

    const warnPriority = [
      'ContainerCreating',
      'PodInitializing',
      'Pending',
      'NotReady',
    ]

    const errorReason = pickReason(
      [
        ...(statusReason ? [statusReason] : []),
        ...initWaitingReasons,
        ...initTerminatedReasons,
        ...waitingReasons,
        ...terminatedReasons,
      ],
      errorPriority
    )
    if (errorReason || phase === 'Failed') {
      return { level: 'error' as const, reason: errorReason || 'Failed', phase }
    }

    const readyCount = containers.filter((c: any) => c?.ready).length
    const totalCount = containers.length
    const notReady = totalCount > 0 && readyCount < totalCount
    const initNotReady = initContainers.length > 0 && initContainers.some((c: any) => {
      const state = c?.state || {}
      if (state.waiting) return true
      if (state.running) return true
      if (state.terminated) {
        const code = state.terminated.exit_code
        return typeof code === 'number' ? code !== 0 : true
      }
      return false
    })

    if (phase === 'Pending' || phase === 'Unknown') {
      return { level: 'warn' as const, reason: phase, phase }
    }

    if (initNotReady) {
      const initReason = pickReason(initWaitingReasons, warnPriority) || 'PodInitializing'
      return { level: 'warn' as const, reason: initReason, phase }
    }

    if (notReady) {
      const warnReason = pickReason(waitingReasons, warnPriority) || 'NotReady'
      return { level: 'warn' as const, reason: warnReason, phase }
    }

    if (phase === 'Succeeded') {
      return { level: 'ok' as const, reason: 'Succeeded', phase }
    }

    const warnReason = pickReason(waitingReasons, warnPriority)
    if (warnReason) {
      return { level: 'warn' as const, reason: warnReason, phase }
    }

    return { level: 'ok' as const, reason: phase, phase }
  }

  const getHealthIcon = (level: 'ok' | 'warn' | 'error', reason?: string) => {
    if (reason === 'PodInitializing' || reason === 'ContainerCreating') {
      return (
        <span
          className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-sky-400 border-t-transparent"
          aria-label="loading"
        />
      )
    }
    if (level === 'ok') {
      return <CheckCircle className="w-5 h-5 text-green-400" />
    }
    if (level === 'error') {
      return <XCircle className="w-5 h-5 text-red-400" />
    }
    return <AlertCircle className="w-5 h-5 text-yellow-400" />
  }

  const handlePodClick = (pod: any) => {
    openDetail({ kind: 'Pod', name: pod.name, namespace: pod.namespace })
  }

  const handlePodContextMenu = (event: React.MouseEvent, pod: PodInfo) => {
    if (!canDeletePod) return
    event.preventDefault()
    setPodContextMenu({ x: event.clientX, y: event.clientY, pod })
  }

  const handleClosePodContextMenu = () => {
    setPodContextMenu(null)
  }

  const openDeleteModal = (pod: PodInfo) => {
    setDeleteTargetPod(pod)
    setDeleteForce(false)
    setDeleteError(null)
  }

  const closeDeleteModal = () => {
    setDeleteTargetPod(null)
    setDeleteForce(false)
    setDeleteError(null)
    setIsDeletingPod(false)
  }

  const handleDeletePod = async () => {
    if (!deleteTargetPod || isDeletingPod) return
    setIsDeletingPod(true)
    setDeleteError(null)
    const target = deleteTargetPod
    const podKey = `${target.namespace}/${target.name}`
    setDeletingPods(prev => new Set(prev).add(podKey))
    try {
      await api.deletePod(target.namespace, target.name, deleteForce)
      closeDeleteModal()
    } catch (error: any) {
      setDeletingPods(prev => {
        const next = new Set(prev)
        next.delete(podKey)
        return next
      })
      setDeleteError(error?.response?.data?.detail || error?.message || '삭제에 실패했습니다.')
    } finally {
      setIsDeletingPod(false)
    }
  }

  useEffect(() => {
    if (!allPods) return
    setDeletingPods(prev => {
      const remaining = new Set<string>()
      const keys = new Set(allPods.map(pod => `${pod.namespace}/${pod.name}`))
      for (const key of prev) {
        if (keys.has(key)) remaining.add(key)
      }
      return remaining
    })
  }, [allPods])

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('clusterView.title', 'Cluster view')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('clusterView.subtitle', 'Review pod placement across nodes')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* 파드 이름 검색 */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder={tr('clusterView.searchPlaceholder', 'Search pod name...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-10 pl-10 pr-4 bg-slate-700 text-white rounded-lg border border-slate-600 focus:outline-none focus:border-primary-500 transition-colors w-64"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 transform -translate-y-1/2 p-1 hover:bg-slate-600 rounded transition-colors"
              >
                <X className="w-4 h-4 text-slate-400" />
              </button>
            )}
          </div>
          {/* 네임스페이스 선택 - 커스텀 드롭다운 */}
          <div className="relative" ref={namespaceDropdownRef}>
            <button
              onClick={() => setIsNamespaceDropdownOpen(!isNamespaceDropdownOpen)}
              className="h-10 px-4 bg-slate-700 hover:bg-slate-600 text-white rounded-lg border border-slate-600 focus:outline-none focus:border-primary-500 transition-colors flex items-center gap-2 min-w-[200px] justify-between"
            >
              <span className="text-sm font-medium">
                {selectedNamespace === 'all'
                  ? tr('clusterView.allNamespaces', 'All namespaces')
                  : selectedNamespace}
              </span>
              <ChevronDown 
                className={`w-4 h-4 text-slate-400 transition-transform ${
                  isNamespaceDropdownOpen ? 'rotate-180' : ''
                }`}
              />
            </button>
            
            {isNamespaceDropdownOpen && (
              <div className="absolute top-full left-0 mt-2 w-full bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-50 max-h-[400px] overflow-y-auto">
                <button
                  onClick={() => {
                    setSelectedNamespace('all')
                    setIsNamespaceDropdownOpen(false)
                  }}
                  className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 first:rounded-t-lg"
                >
                  {selectedNamespace === 'all' && (
                    <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
                  )}
                  <span className={selectedNamespace === 'all' ? 'font-medium' : ''}>
                    {tr('clusterView.allNamespaces', 'All namespaces')}
                  </span>
                </button>
                {Array.isArray(namespaces) && namespaces.map((ns) => (
                  <button
                    key={ns.name}
                    onClick={() => {
                      setSelectedNamespace(ns.name)
                      setIsNamespaceDropdownOpen(false)
                    }}
                    className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 last:rounded-b-lg"
                  >
                    {selectedNamespace === ns.name && (
                      <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
                    )}
                    <span className={selectedNamespace === ns.name ? 'font-medium' : ''}>
                      {ns.name}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* 새로고침 버튼 숨김 (watch 기반 실시간 갱신) */}
        </div>
      </div>

      {isLoading ? (
        <div className="flex flex-col items-center justify-center h-full min-h-[300px]">
          <RefreshCw className="w-8 h-8 text-primary-400 animate-spin mb-4" />
          <p className="text-slate-400">{tr('clusterView.loading', 'Loading data...')}</p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* 검색 결과 정보 */}
          {searchQuery && (
            <div className="text-sm text-slate-400">
              {tr('clusterView.searchResults', 'Results')}:{' '}
              <span className="text-white font-medium">{filteredPods.length}</span>{' '}
              {tr('clusterView.countSuffix', 'items')}
              {filteredPods.length !== (allPods?.length || 0) && (
                <span className="ml-2">
                  {tr('clusterView.searchResultsTotal', '(out of {{count}})', { count: allPods?.length || 0 })}
                </span>
              )}
            </div>
          )}
          
          {/* 검색 결과가 없을 때 */}
          {searchQuery && filteredPods.length === 0 && (
            <div className="card text-center py-12">
              <Search className="w-12 h-12 text-slate-600 mx-auto mb-4" />
              <p className="text-slate-400">
                {tr('clusterView.noSearchResults', 'No pods found for "{{query}}"', { query: searchQuery })}
              </p>
            </div>
          )}

          {/* 노드별 Pod 표시 */}
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
      )}

      {/* Pod 우클릭 컨텍스트 메뉴 */}
      {podContextMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={handleClosePodContextMenu}
            onContextMenu={(event) => {
              event.preventDefault()
              handleClosePodContextMenu()
            }}
          />
          <div
            className="fixed z-50 bg-slate-700 border border-slate-600 rounded-lg shadow-lg py-1 min-w-[140px]"
            style={{ left: `${podContextMenu.x}px`, top: `${podContextMenu.y}px` }}
            role="menu"
          >
            <button
              onClick={(event) => {
                event.stopPropagation()
                openDeleteModal(podContextMenu.pod)
                handleClosePodContextMenu()
              }}
              className="w-full px-4 py-2 text-left text-sm text-red-400 hover:bg-slate-600 flex items-center gap-2"
              role="menuitem"
            >
              <Trash2 className="w-4 h-4" />
              삭제
            </button>
          </div>
        </>
      )}

      {deleteTargetPod && (
        <ModalOverlay onClose={closeDeleteModal}>
          <div
            className="bg-slate-800 rounded-lg w-full max-w-lg p-6"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Pod 삭제"
          >
            <h2 className="text-xl font-bold text-white mb-4">Pod 삭제</h2>
            <p className="text-slate-300 leading-relaxed">
              <strong>Pod</strong>{' '}
              <kbd className="px-1.5 py-0.5 rounded bg-slate-700 text-slate-100">
                {deleteTargetPod.name}
              </kbd>
              를 삭제할까요?
            </p>
            <p className="text-slate-400 mt-3">
              리소스 삭제는 <strong>위험</strong>할 수 있습니다. 삭제 효과를 충분히 이해한 뒤 진행하세요.
              가능하면 변경 전 다른 사람의 리뷰를 받는 것을 권장합니다.
            </p>

            <div className="mt-4 flex items-center gap-2">
              <input
                id="force-delete-checkbox"
                type="checkbox"
                checked={deleteForce}
                onChange={(event) => setDeleteForce(event.target.checked)}
                className="w-4 h-4 rounded border-slate-500 bg-slate-700"
              />
              <label htmlFor="force-delete-checkbox" className="text-sm text-slate-300">
                강제 삭제
              </label>
              <span title="체크 시 grace period를 무시하고 즉시 삭제합니다">
                <HelpCircle className="w-4 h-4 text-slate-400" />
              </span>
            </div>

            {deleteError && (
              <div className="mt-4 text-sm text-red-400">{deleteError}</div>
            )}

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={closeDeleteModal}
                disabled={isDeletingPod}
              >
                취소
              </button>
              <button
                type="button"
                className="btn bg-red-600 hover:bg-red-700 text-white disabled:opacity-60"
                onClick={handleDeletePod}
                disabled={isDeletingPod}
              >
                확인
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}
    </div>
  )
}
