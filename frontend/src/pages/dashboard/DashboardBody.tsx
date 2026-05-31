import { useQueryClient } from '@tanstack/react-query'
import { Server, Box, Database, HardDrive, TrendingUp } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { usePrometheusQueries } from '@/hooks/usePrometheusQuery'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { useDashboard } from './DashboardContext'
import { DashboardSkeleton } from './DashboardSkeleton'
import { DashboardHeader } from './DashboardHeader'
import { DashboardQuickActions } from './DashboardQuickActions'
import { DashboardTopResources } from './DashboardTopResources'
import { DashboardPodNodeStatus } from './DashboardPodNodeStatus'
import { DashboardNodeList } from './DashboardNodeList'
import { StatsGrid } from './StatsGrid'
import { PrometheusClusterMetrics } from './PrometheusClusterMetrics'
import { IssuesModal } from './modals/IssuesModal'
import { OptimizationModal } from './modals/OptimizationModal'
import { ResourceModal } from './modals/ResourceModal'
import { StorageModal } from './modals/StorageModal'
import { useDashboardQueries } from './hooks/useDashboardQueries'
import { useDashboardRefresh } from './hooks/useDashboardRefresh'
import { useOptimizationStream } from './hooks/useOptimizationStream'
import { useDashboardIssues } from './hooks/useDashboardIssues'
import { useDashboardStorage } from './hooks/useDashboardStorage'
import { useDashboardAIContext } from './hooks/useDashboardAIContext'
import type { ResourceType } from './types'
import { unwrapOuterMarkdownFence, makeStreamingMarkdownRenderFriendly } from './utils'

// Dashboard 의 거대 body. DashboardProvider 안에서만 mount.
// Provider 분리 (Dashboard.tsx) + body 분리 (이 파일) 로 root container 와
// modal/filter state container 의 책임을 깔끔히 나눈다.

export function DashboardBody() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const { open: openDetail } = useResourceDetail()
  const tr = (key: string, fallback: string, options?: Record<string, any>) => t(key, { defaultValue: fallback, ...options })
  const { isRefreshing, handleRefresh } = useDashboardRefresh()

  // Modal / filter state — DashboardContext 에서 lifted.
  const {
    selectedResourceType, setSelectedResourceType,
    modalSearchQuery, setModalSearchQuery,
    selectedPodStatus, setSelectedPodStatus,
    selectedNodeStatus, setSelectedNodeStatus,
    closeResourceModal,
    isIssuesModalOpen, setIsIssuesModalOpen,
    issuesSearchQuery, setIssuesSearchQuery,
    includeRestartHistory, setIncludeRestartHistory,
    closeIssuesModal,
    isStorageModalOpen, setIsStorageModalOpen,
    storageActiveTab, setStorageActiveTab,
    storageSearchQuery, setStorageSearchQuery,
    storageNamespaceFilter, setStorageNamespaceFilter,
    isStorageNamespaceDropdownOpen, setIsStorageNamespaceDropdownOpen,
    closeStorageModal,
  } = useDashboard()

  const {
    isOptimizationModalOpen,
    setIsOptimizationModalOpen,
    optimizationNamespace,
    setOptimizationNamespace,
    isOptimizationNamespaceDropdownOpen,
    setIsOptimizationNamespaceDropdownOpen,
    optimizationCopied,
    isOptimizationStreaming,
    optimizationObservedContent,
    optimizationAnswerContent,
    optimizationStreamError,
    optimizationUsage,
    optimizationMeta,
    openOptimizationModal,
    handleCloseOptimizationModal,
    handleRunOptimizationSuggestions,
    handleCopyOptimizationSuggestions,
    handleStopOptimizationSuggestions,
  } = useOptimizationStream()

  const {
    overview,
    isLoading,
    namespaces,
    isLoadingNamespaces,
    allPods,
    isLoadingPods,
    allNamespaces,
    isLoadingAllNamespaces,
    allServices,
    isLoadingServices,
    allDeployments,
    isLoadingDeployments,
    allPVCs,
    isLoadingPVCs,
    allPVs,
    isLoadingPVs,
    storageTopology,
    isLoadingStorageTopology,
    isStorageTopologyError,
    storageTopologyError,
    nodes,
    topResources,
    isLoadingTopResources,
    isTopResourcesError,
    modalNodes,
    isLoadingNodes,
    metricsUnavailable,
  } = useDashboardQueries({
    selectedResourceType,
    selectedPodStatus,
    isIssuesModalOpen,
    isStorageModalOpen,
    isOptimizationModalOpen,
    storageActiveTab,
  })

  // 플로팅 AI 위젯의 "현재 화면 컨텍스트" snapshot — useDashboardAIContext hook 으로 분리
  useDashboardAIContext({ overview, nodes, topResources, allPods })

  // Prometheus cluster-wide metrics
  const promCluster = usePrometheusQueries(
    ['cluster-dashboard'],
    [
      { name: 'cpu', promql: '100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)' },
      { name: 'memory', promql: '(1 - sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes)) * 100' },
      { name: 'disk', promql: '(1 - sum(node_filesystem_avail_bytes{mountpoint="/"}) / sum(node_filesystem_size_bytes{mountpoint="/"})) * 100' },
      { name: 'pod_count', promql: 'count(kube_pod_info)' },
    ],
    { refetchInterval: 30000 },
  )
  const getClusterMetric = (n: string): number | null => {
    const resp = promCluster.data[n]
    if (!resp?.available || !resp.results?.length) return null
    return resp.results[0].value
  }

  const handleStatClick = (type: ResourceType) => {
    setSelectedResourceType(type)
  }

  const handleOpenIssuesModal = () => {
    closeResourceModal()
    setIsStorageModalOpen(false)
    setIsOptimizationModalOpen(false)
    setIsIssuesModalOpen(true)
  }

  const handleOpenStorageModal = () => {
    closeResourceModal()
    setIsIssuesModalOpen(false)
    setIsOptimizationModalOpen(false)
    setStorageActiveTab('pvcs')
    setStorageSearchQuery('')
    setStorageNamespaceFilter('all')
    setIsStorageNamespaceDropdownOpen(false)
    setIsStorageModalOpen(true)
  }

  const handleOpenOptimizationModal = () => {
    closeResourceModal()
    setIsIssuesModalOpen(false)
    setIsStorageModalOpen(false)
    setIsStorageNamespaceDropdownOpen(false)

    // 기본 namespace 결정 (default 우선, 없으면 첫 번째)
    const namespaceNames = Array.isArray(allNamespaces)
      ? allNamespaces.map((ns: any) => String(ns?.name ?? '')).filter(Boolean)
      : []
    const preferred = namespaceNames.includes('default') ? 'default' : (namespaceNames[0] ?? 'default')

    openOptimizationModal(preferred)
  }

  useEffect(() => {
    if (!isIssuesModalOpen) return
    // 모달을 열 때마다 최신 상태(특히 CrashLoopBackOff reason 등)를 다시 가져오도록 강제한다.
    void queryClient.invalidateQueries({ queryKey: ['all-pods'], refetchType: 'active' })
    void queryClient.invalidateQueries({ queryKey: ['all-pvcs'], refetchType: 'active' })
    void queryClient.invalidateQueries({ queryKey: ['all-namespaces'], refetchType: 'active' })
    void queryClient.invalidateQueries({ queryKey: ['all-deployments'], refetchType: 'active' })
    void queryClient.invalidateQueries({ queryKey: ['nodes'], refetchType: 'active' })
  }, [isIssuesModalOpen, queryClient])

  useEffect(() => {
    if (!isStorageModalOpen) return
    void queryClient.invalidateQueries({ queryKey: ['all-pvcs'], refetchType: 'active' })
    void queryClient.invalidateQueries({ queryKey: ['all-pvs'], refetchType: 'active' })
    void queryClient.invalidateQueries({ queryKey: ['storage-topology'], refetchType: 'active' })
  }, [isStorageModalOpen, queryClient])

  useEffect(() => {
    if (!isOptimizationModalOpen) return
    void queryClient.invalidateQueries({ queryKey: ['all-namespaces'], refetchType: 'active' })
  }, [isOptimizationModalOpen, queryClient])

  useEffect(() => {
    if (!isOptimizationModalOpen) return
    if (!Array.isArray(allNamespaces) || allNamespaces.length === 0) return
    const namespaceNames = allNamespaces.map((ns: any) => String(ns?.name ?? '')).filter(Boolean)
    if (!namespaceNames.includes(optimizationNamespace)) {
      setOptimizationNamespace(namespaceNames.includes('default') ? 'default' : namespaceNames[0])
    }
  }, [isOptimizationModalOpen, allNamespaces, optimizationNamespace])

  const handleNodeClick = (node: any) => {
    openDetail({ kind: 'Node', name: node.name })
  }

  const handlePodStatusClick = (status: string) => {
    setSelectedPodStatus(status)
    setSelectedResourceType('pods')
  }

  const handleNodeStatusClick = (status: string) => {
    setSelectedNodeStatus(status)
    setSelectedResourceType('nodes')
  }

  // ESC 키로 모달 닫기
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isIssuesModalOpen) closeIssuesModal()
        if (isStorageModalOpen) closeStorageModal()
        if (selectedResourceType) closeResourceModal()
      }
    }
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('keydown', handleEscape)
    }
  }, [selectedResourceType, isIssuesModalOpen, isStorageModalOpen])

  // 선택된 리소스 타입에 해당하는 stat 정보 가져오기
  const getSelectedStat = () => {
    return stats.find((s) => s.resourceType === selectedResourceType)
  }

  // 리소스 개수 가져오기
  const getResourceCount = () => {
    if (selectedResourceType === 'namespaces') return Array.isArray(namespaces) ? namespaces.length : 0
    if (selectedResourceType === 'pods') return Array.isArray(allPods) ? allPods.length : 0
    if (selectedResourceType === 'services') return Array.isArray(allServices) ? allServices.length : 0
    if (selectedResourceType === 'deployments') return Array.isArray(allDeployments) ? allDeployments.length : 0
    if (selectedResourceType === 'pvcs') return Array.isArray(allPVCs) ? allPVCs.length : 0
    if (selectedResourceType === 'nodes') return Array.isArray(modalNodes) ? modalNodes.length : 0
    return 0
  }

  // 로딩 상태 확인
  const isLoadingResource = () => {
    if (selectedResourceType === 'namespaces') return isLoadingNamespaces
    if (selectedResourceType === 'pods') return isLoadingPods
    if (selectedResourceType === 'services') return isLoadingAllNamespaces || isLoadingServices
    if (selectedResourceType === 'deployments') return isLoadingAllNamespaces || isLoadingDeployments
    if (selectedResourceType === 'pvcs') return isLoadingPVCs
    if (selectedResourceType === 'nodes') return isLoadingNodes
    return false
  }

  // 검색어로 리소스 필터링
  const getFilteredResources = () => {
    let resources: any[] = []

    // 리소스 타입별 기본 데이터 - 항상 배열 보장
    if (selectedResourceType === 'namespaces') resources = Array.isArray(namespaces) ? namespaces : []
    else if (selectedResourceType === 'pods') resources = Array.isArray(allPods) ? allPods : []
    else if (selectedResourceType === 'services') resources = Array.isArray(allServices) ? allServices : []
    else if (selectedResourceType === 'deployments') resources = Array.isArray(allDeployments) ? allDeployments : []
    else if (selectedResourceType === 'pvcs') resources = Array.isArray(allPVCs) ? allPVCs : []
    else if (selectedResourceType === 'nodes') resources = Array.isArray(modalNodes) ? modalNodes : []

    // Pod 상태 필터링
    if (selectedPodStatus && selectedResourceType === 'pods') {
      resources = resources.filter((pod: any) => pod.phase === selectedPodStatus)
    }

    // Node 상태 필터링
    if (selectedNodeStatus && selectedResourceType === 'nodes') {
      resources = resources.filter((node: any) => node.status === selectedNodeStatus)
    }

    // 검색어 필터링
    if (!modalSearchQuery.trim()) return resources

    const query = modalSearchQuery.toLowerCase()

    if (selectedResourceType === 'namespaces') {
      return resources.filter((ns: any) =>
        ns.name.toLowerCase().includes(query)
      )
    }

    if (selectedResourceType === 'pods') {
      return resources.filter((pod: any) =>
        pod.name.toLowerCase().includes(query) ||
        pod.namespace.toLowerCase().includes(query) ||
        (pod.node_name && pod.node_name.toLowerCase().includes(query))
      )
    }

    if (selectedResourceType === 'services') {
      return resources.filter((svc: any) =>
        svc.name.toLowerCase().includes(query) ||
        svc.namespace.toLowerCase().includes(query) ||
        (svc.type && svc.type.toLowerCase().includes(query)) ||
        (svc.cluster_ip && svc.cluster_ip.toLowerCase().includes(query))
      )
    }

    if (selectedResourceType === 'deployments') {
      return resources.filter((deploy: any) =>
        deploy.name.toLowerCase().includes(query) ||
        deploy.namespace.toLowerCase().includes(query)
      )
    }

    if (selectedResourceType === 'pvcs') {
      return resources.filter(pvc =>
        pvc.name.toLowerCase().includes(query) ||
        pvc.namespace.toLowerCase().includes(query) ||
        (pvc.storage_class && pvc.storage_class.toLowerCase().includes(query))
      )
    }

    if (selectedResourceType === 'nodes') {
      return resources.filter(node =>
        node.name.toLowerCase().includes(query) ||
        (node.version && node.version.toLowerCase().includes(query)) ||
        (node.internal_ip && node.internal_ip.toLowerCase().includes(query)) ||
        (node.roles && node.roles.some((role: string) => role.toLowerCase().includes(query)))
      )
    }

    return []
  }

  const filteredResources = getFilteredResources()

  // Issues derived computation: 270줄 inline → useDashboardIssues hook.
  // ⚠️ 모든 hook 호출은 early return 보다 먼저 — `if (isLoading)` 이후에 두면
  // 첫 render(skeleton)와 두번째 render(본문) 사이 hook count 가 달라져
  // "Rendered more hooks than during the previous render" 가 터진다.
  const { sortedIssues, issuesByKind, issuesSummary, isIssuesLoading } = useDashboardIssues({
    allPods, nodes, allPVCs, allDeployments, topResources,
    includeRestartHistory, issuesSearchQuery,
    isIssuesModalOpen, isLoadingPods, isLoadingPVCs, isLoadingAllNamespaces, isLoadingDeployments,
    tr,
  })

  // Storage 모달 derived (filter/sort/status counts) 도 hook 으로 — 위 hook 과
  // 같은 이유로 early return 보다 먼저.
  const {
    storageNamespaces,
    sortedPVCsForStorage,
    sortedPVsForStorage,
    pvcStatusCounts,
    pvStatusCounts,
    isStorageLoading,
  } = useDashboardStorage({
    allPVCs, allPVs, allNamespaces,
    storageSearchQuery, storageNamespaceFilter, storageActiveTab,
    isStorageModalOpen, isLoadingPVCs, isLoadingPVs, isLoadingStorageTopology,
  })

  if (isLoading) {
    return <DashboardSkeleton />
  }

  // Pod/Node 상태는 Kubernetes 스펙상 가능한 값이 제한적이므로
  // 차트에서 항상 전체 상태를 보여주기 위해 고정 목록 사용
  const POD_PHASES = ['Running', 'Succeeded', 'Failed', 'Pending', 'Unknown']
  const NODE_STATUSES = ['Ready', 'NotReady']

  const stats = [
    {
      name: tr('dashboard.stats.namespaces', 'Namespaces'),
      resourceType: 'namespaces' as ResourceType,
      value: overview?.total_namespaces || 0,
      icon: Server,
      color: 'text-blue-400',
      bgColor: 'bg-blue-500/10',
    },
    {
      name: tr('dashboard.stats.pods', 'Pods'),
      resourceType: 'pods' as ResourceType,
      value: overview?.total_pods || 0,
      icon: Box,
      color: 'text-green-400',
      bgColor: 'bg-green-500/10',
    },
    {
      name: tr('dashboard.stats.services', 'Services'),
      resourceType: 'services' as ResourceType,
      value: overview?.total_services || 0,
      icon: Database,
      color: 'text-purple-400',
      bgColor: 'bg-purple-500/10',
    },
    {
      name: tr('dashboard.stats.deployments', 'Deployments'),
      resourceType: 'deployments' as ResourceType,
      value: overview?.total_deployments || 0,
      icon: TrendingUp,
      color: 'text-yellow-400',
      bgColor: 'bg-yellow-500/10',
    },
    {
      name: tr('dashboard.stats.pvcs', 'PVCs'),
      resourceType: 'pvcs' as ResourceType,
      value: overview?.total_pvcs || 0,
      icon: HardDrive,
      color: 'text-pink-400',
      bgColor: 'bg-pink-500/10',
    },
    {
      name: tr('dashboard.stats.nodes', 'Nodes'),
      resourceType: 'nodes' as ResourceType,
      value: overview?.node_count || 0,
      icon: Server,
      color: 'text-cyan-400',
      bgColor: 'bg-cyan-500/10',
    },
  ]

  // Pod 상태 차트 데이터
  const podStatusData = overview
    ? POD_PHASES.map((phase) => ({
      name: phase,
      value: overview?.pod_status?.[phase] ?? 0,
    }))
    : []

  // 노드 상태 차트 데이터
  const nodeStatusData = nodes && Array.isArray(nodes)
    ? nodes.reduce((acc: Record<string, number>, node) => {
      const status = node.status || 'Unknown'
      acc[status] = (acc[status] || 0) + 1
      return acc
    }, {} as Record<string, number>)
    : {}

  const nodeStatusChartData = nodes && Array.isArray(nodes)
    ? NODE_STATUSES.map((status) => ({
      name: status,
      value: nodeStatusData[status] ?? 0,
    }))
    : []

  const optimizationNamespaces = Array.isArray(allNamespaces)
    ? allNamespaces.map((ns: any) => String(ns?.name ?? '')).filter(Boolean).sort()
    : []

  const optimizationObservedMarkdown = optimizationObservedContent
    .replace(/\n\n---\n\n## 최적화 제안 \(AI\)\n\n\s*$/m, '')
    .trim()
  const optimizationAnswerMarkdown = unwrapOuterMarkdownFence(optimizationAnswerContent).trim()
  const optimizationAnswerMarkdownForStreaming = makeStreamingMarkdownRenderFriendly(optimizationAnswerMarkdown)
  const optimizationMarkdown = `${optimizationObservedContent}${unwrapOuterMarkdownFence(optimizationAnswerContent)}`.trim()
  return (
    <div className="space-y-8">
      <DashboardHeader
        clusterVersion={overview?.cluster_version}
        isRefreshing={isRefreshing}
        onRefresh={handleRefresh}
      />

      <StatsGrid stats={stats} onStatClick={handleStatClick} />

      <DashboardPodNodeStatus
        podStatusData={podStatusData}
        nodeStatusChartData={nodeStatusChartData}
        onPodStatusClick={handlePodStatusClick}
        onNodeStatusClick={handleNodeStatusClick}
      />

      {promCluster.available && (
        <PrometheusClusterMetrics
          title={tr('dashboard.clusterMetrics', 'Cluster Resource Utilization')}
          cpu={getClusterMetric('cpu')}
          memory={getClusterMetric('memory')}
          disk={getClusterMetric('disk')}
          podCount={getClusterMetric('pod_count')}
        />
      )}

      <DashboardTopResources
        topResources={topResources}
        isLoading={isLoadingTopResources}
        isError={isTopResourcesError}
        metricsUnavailable={metricsUnavailable}
      />

      <DashboardNodeList
        nodes={nodes ?? []}
        onNodeClick={handleNodeClick}
      />

      <DashboardQuickActions
        onOpenIssues={handleOpenIssuesModal}
        onOpenOptimization={handleOpenOptimizationModal}
        onOpenStorage={handleOpenStorageModal}
      />

      <OptimizationModal
        open={isOptimizationModalOpen}
        onClose={handleCloseOptimizationModal}
        namespace={optimizationNamespace}
        setNamespace={setOptimizationNamespace}
        namespaces={optimizationNamespaces}
        isLoadingNamespaces={isLoadingAllNamespaces}
        isDropdownOpen={isOptimizationNamespaceDropdownOpen}
        setIsDropdownOpen={setIsOptimizationNamespaceDropdownOpen}
        isStreaming={isOptimizationStreaming}
        copied={optimizationCopied}
        fullMarkdown={optimizationMarkdown}
        observedMarkdown={optimizationObservedMarkdown}
        answerMarkdown={optimizationAnswerMarkdown}
        answerMarkdownForStreaming={optimizationAnswerMarkdownForStreaming}
        answerContent={optimizationAnswerContent}
        streamError={optimizationStreamError}
        usage={optimizationUsage}
        meta={optimizationMeta}
        onRun={handleRunOptimizationSuggestions}
        onStop={handleStopOptimizationSuggestions}
        onCopy={handleCopyOptimizationSuggestions}
      />

      <IssuesModal
        open={isIssuesModalOpen}
        onClose={closeIssuesModal}
        includeRestartHistory={includeRestartHistory}
        setIncludeRestartHistory={setIncludeRestartHistory}
        searchQuery={issuesSearchQuery}
        setSearchQuery={setIssuesSearchQuery}
        isLoading={isIssuesLoading}
        sortedIssues={sortedIssues}
        issuesByKind={issuesByKind}
        issuesSummary={issuesSummary}
      />

      <StorageModal
        open={isStorageModalOpen}
        onClose={closeStorageModal}
        sortedPVCs={sortedPVCsForStorage}
        sortedPVs={sortedPVsForStorage}
        pvcStatusCounts={pvcStatusCounts}
        pvStatusCounts={pvStatusCounts}
        activeTab={storageActiveTab}
        setActiveTab={setStorageActiveTab}
        namespaceFilter={storageNamespaceFilter}
        setNamespaceFilter={setStorageNamespaceFilter}
        namespaces={storageNamespaces}
        isDropdownOpen={isStorageNamespaceDropdownOpen}
        setIsDropdownOpen={setIsStorageNamespaceDropdownOpen}
        searchQuery={storageSearchQuery}
        setSearchQuery={setStorageSearchQuery}
        isLoading={isStorageLoading}
        storageTopology={storageTopology}
        isLoadingStorageTopology={isLoadingStorageTopology}
        isStorageTopologyError={isStorageTopologyError}
        storageTopologyError={storageTopologyError}
      />

      <ResourceModal
        selectedResourceType={selectedResourceType}
        onClose={closeResourceModal}
        selectedStat={getSelectedStat()}
        isLoading={isLoadingResource()}
        resourceCount={getResourceCount()}
        searchQuery={modalSearchQuery}
        setSearchQuery={setModalSearchQuery}
        filteredResources={filteredResources}
      />
    </div>
  )
}
