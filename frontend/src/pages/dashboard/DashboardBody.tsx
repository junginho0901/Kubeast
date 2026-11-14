import { useQueryClient } from '@tanstack/react-query'
import { Server, Box, Database, HardDrive, TrendingUp } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useClusterFeatures, usePrometheusQueries } from '@/hooks/usePrometheusQuery'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { clusterNodeQueries } from '@/utils/nodeMetrics'
import { NODE_READINESS, nodeReadiness } from '@/utils/nodeStatus'
import { useDashboard } from './DashboardContext'
import { DashboardSkeleton } from './DashboardSkeleton'
import { DashboardHeader } from './DashboardHeader'
import { DashboardQuickActions } from './DashboardQuickActions'
import { DashboardTopResources } from './DashboardTopResources'
import { DashboardPodNodeStatus } from './DashboardPodNodeStatus'
import { DashboardNodeList } from './DashboardNodeList'
import { StatsGrid } from './StatsGrid'
import { PrometheusClusterMetrics, PrometheusClusterMetricsFailure } from './PrometheusClusterMetrics'
import { namespaceCounts } from './namespaceCounts'
import { issueTarget } from './issues'
import { IssuesModal } from './modals/IssuesModal'
import { OptimizationModal } from './modals/OptimizationModal'
import { ResourceModal } from './modals/ResourceModal'
import { StorageModal } from './modals/StorageModal'
import { useDashboardQueries } from './hooks/useDashboardQueries'
import { useDashboardRefresh } from './hooks/useDashboardRefresh'
import { RefreshFailure } from '@/components/RefreshFailure'
import { useOptimizationStream } from './hooks/useOptimizationStream'
import { useDashboardIssues } from './hooks/useDashboardIssues'
import { useDashboardStorage } from './hooks/useDashboardStorage'
import { useDashboardAIContext } from './hooks/useDashboardAIContext'
import type { IssueItem, ResourceType } from './types'
import { unwrapOuterMarkdownFence, makeStreamingMarkdownRenderFriendly } from './utils'

const clusterNodes = clusterNodeQueries()

// Dashboard 의 거대 body. DashboardProvider 안에서만 mount.
// Provider 분리 (Dashboard.tsx) + body 분리 (이 파일) 로 root container 와
// modal/filter state container 의 책임을 깔끔히 나눈다.

export function DashboardBody() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const { open: openDetail } = useResourceDetail()
  const tr = (key: string, fallback: string, options?: Record<string, any>) => t(key, { defaultValue: fallback, ...options })
  const { isRefreshing, handleRefresh, refreshFailure } = useDashboardRefresh()

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
    issuesWindowMinutes, setIssuesWindowMinutes,
    closeIssuesModal,
    isStorageModalOpen, setIsStorageModalOpen,
    storageActiveTab, setStorageActiveTab,
    storageSearchQuery, setStorageSearchQuery,
    storageNamespaceFilter, setStorageNamespaceFilter,
    isStorageNamespaceDropdownOpen, setIsStorageNamespaceDropdownOpen,
    closeStorageModal,
  } = useDashboard()

  // The Pods window's search reaches the server after a pause, an empty one at once (a window closed and opened again
  // asks with none); its page goes back to 1 in the same render when what it shows changes, so no read asks the old page.
  const [typedPodSearch, setTypedPodSearch] = useState('')
  useEffect(() => {
    const q = modalSearchQuery.trim()
    if (!q) {
      setTypedPodSearch('')
      return
    }
    const id = setTimeout(() => setTypedPodSearch(q), 250)
    return () => clearTimeout(id)
  }, [modalSearchQuery])
  const podSearch = modalSearchQuery.trim() ? typedPodSearch : ''
  const podPageFor = `${selectedResourceType}\u0000${podSearch}\u0000${selectedPodStatus}`
  const [podPaged, setPodPaged] = useState({ key: podPageFor, page: 1 })
  const podPageNo = podPaged.key === podPageFor ? podPaged.page : 1
  const setPodPageNo = (page: number) => setPodPaged({ key: podPageFor, page })

  const {
    isOptimizationModalOpen,
    setIsOptimizationModalOpen,
    optimizationNamespace,
    setOptimizationNamespace,
    isOptimizationNamespaceDropdownOpen,
    setIsOptimizationNamespaceDropdownOpen,
    optimizationCopied,
    optimizationCopyFailed,
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
    isOverviewError,
    isLoading,
    namespaces,
    isLoadingNamespaces,
    podPage,
    problemPods,
    isLoadingPods,
    clusterIssues,
    isLoadingIssues,
    issuesError,
    optimizationTable,
    isLoadingOptimizationTable,
    optimizationTableError,
    allNamespaces,
    isLoadingAllNamespaces,
    allServices,
    isLoadingServices,
    isServicesError,
    allDeployments,
    isLoadingDeployments,
    isDeploymentsError,
    namespacePods,
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
    topResourcesError,
    modalNodes,
    isLoadingNodes,
    metricsUnavailable,
  } = useDashboardQueries({
    selectedResourceType,
    selectedPodStatus,
    isIssuesModalOpen,
    issuesWindowMinutes,
    includeRestartHistory,
    isStorageModalOpen,
    isOptimizationModalOpen,
    optimizationNamespace,
    storageActiveTab,
    podQuery: { q: podSearch, page: podPageNo },
  })
  const defaultIssuesWindowMinutes = useClusterFeatures().data?.issues?.eventWindowMinutes ?? 60

  // 플로팅 AI 위젯의 "현재 화면 컨텍스트" snapshot — useDashboardAIContext hook 으로 분리
  useDashboardAIContext({ overview, nodes, topResources, problemPods })

  // Prometheus cluster-wide metrics
  const promCluster = usePrometheusQueries(
    ['cluster-dashboard'],
    [
      { name: 'cpu', promql: clusterNodes.cpu },
      { name: 'memory', promql: clusterNodes.memory },
      { name: 'disk', promql: clusterNodes.filesystem },
      // the pods holding a node's pod slot — placed on a node and not finished, as kubectl describe node's
      // Non-terminated Pods — each namespace/pod once (two kube-state-metrics, or one scraped twice, count twice)
      { name: 'pod_count', promql: 'count(count by (namespace, pod) (kube_pod_status_phase{phase=~"Pending|Running"} == 1) and on (namespace, pod) kube_pod_info{node!=""})' },
      { name: 'pod_capacity', promql: 'sum(max by (node) (kube_node_status_allocatable{resource="pods"}))' },
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
    void queryClient.invalidateQueries({ queryKey: ['cluster-issues'], refetchType: 'active' })
  }, [isIssuesModalOpen, queryClient])

  // 이슈 행 클릭 → 그 객체의 드로어 (Collector 행은 열 곳이 없음).
  const handleOpenIssue = (issue: IssueItem) => {
    const target = issueTarget(issue)
    if (!target) return
    closeIssuesModal()
    openDetail(target)
  }

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
  }, [isOptimizationModalOpen, allNamespaces, optimizationNamespace, setOptimizationNamespace])

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
  }, [selectedResourceType, isIssuesModalOpen, isStorageModalOpen, closeIssuesModal, closeStorageModal, closeResourceModal])

  // 선택된 리소스 타입에 해당하는 stat 정보 가져오기
  const getSelectedStat = () => {
    return stats.find((s) => s.resourceType === selectedResourceType)
  }

  // 리소스 개수 가져오기
  const getResourceCount = () => {
    if (selectedResourceType === 'namespaces') return Array.isArray(namespaces) ? namespaces.length : 0
    if (selectedResourceType === 'pods') return podPage?.stats.total ?? 0
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
    if (selectedResourceType === 'services') return isLoadingServices
    if (selectedResourceType === 'deployments') return isLoadingDeployments
    if (selectedResourceType === 'pvcs') return isLoadingPVCs
    if (selectedResourceType === 'nodes') return isLoadingNodes
    return false
  }

  // 검색어로 리소스 필터링
  const getFilteredResources = () => {
    let resources: any[] = []

    // 리소스 타입별 기본 데이터 - 항상 배열 보장
    if (selectedResourceType === 'namespaces') resources = Array.isArray(namespaces) ? namespaces : []
    // already filtered (phase, search) and cut to the page by the server
    else if (selectedResourceType === 'pods') return podPage?.items ?? []
    else if (selectedResourceType === 'services') resources = Array.isArray(allServices) ? allServices : []
    else if (selectedResourceType === 'deployments') resources = Array.isArray(allDeployments) ? allDeployments : []
    else if (selectedResourceType === 'pvcs') resources = Array.isArray(allPVCs) ? allPVCs : []
    else if (selectedResourceType === 'nodes') resources = Array.isArray(modalNodes) ? modalNodes : []

    // Node 상태 필터링
    if (selectedNodeStatus && selectedResourceType === 'nodes') {
      resources = resources.filter((node: any) => nodeReadiness(node.status) === selectedNodeStatus)
    }

    // 검색어 필터링
    if (!modalSearchQuery.trim()) return resources

    const query = modalSearchQuery.toLowerCase()

    if (selectedResourceType === 'namespaces') {
      return resources.filter((ns: any) =>
        ns.name.toLowerCase().includes(query)
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

  // Issues: 서버 집계(/cluster/issues)를 검색·정렬·그룹만 — useDashboardIssues hook.
  // ⚠️ 모든 hook 호출은 early return 보다 먼저 — `if (isLoading)` 이후에 두면
  // 첫 render(skeleton)와 두번째 render(본문) 사이 hook count 가 달라져
  // "Rendered more hooks than during the previous render" 가 터진다.
  const { sortedIssues, issuesByKind, kinds: issueKinds, issuesSummary, isIssuesLoading, generatedAt: issuesGeneratedAt } = useDashboardIssues({
    issues: clusterIssues,
    issuesSearchQuery,
    isIssuesModalOpen,
    isLoadingIssues,
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

  // A refused overview (403: the user's cluster identity may not list namespaces) shows no number at all — 0 would read as an empty cluster;
  // so does a kind that identity may not list (null, named in `refused`).
  const count = (n?: number | null) => (isOverviewError || n === null ? '—' : n || 0)
  const refusedTitle = (resource: string, kind: string) =>
    overview?.refused?.includes(resource) ? tr('dashboard.stats.refused', 'Your identity in this cluster may not list {{kind}}, so they are not counted.', { kind }) : undefined
  const stats = [
    {
      name: tr('dashboard.stats.namespaces', 'Namespaces'),
      resourceType: 'namespaces' as ResourceType,
      value: count(overview?.total_namespaces),
      icon: Server,
    },
    {
      name: tr('dashboard.stats.pods', 'Pods'),
      resourceType: 'pods' as ResourceType,
      value: count(overview?.total_pods),
      title: refusedTitle('pods', 'Pods'),
      icon: Box,
    },
    {
      name: tr('dashboard.stats.services', 'Services'),
      resourceType: 'services' as ResourceType,
      value: count(overview?.total_services),
      title: refusedTitle('services', 'Services'),
      icon: Database,
    },
    {
      name: tr('dashboard.stats.deployments', 'Deployments'),
      resourceType: 'deployments' as ResourceType,
      value: count(overview?.total_deployments),
      title: refusedTitle('deployments', 'Deployments'),
      icon: TrendingUp,
    },
    {
      name: tr('dashboard.stats.pvcs', 'PVCs'),
      resourceType: 'pvcs' as ResourceType,
      value: count(overview?.total_pvcs),
      title: refusedTitle('persistentvolumeclaims', 'PersistentVolumeClaims'),
      icon: HardDrive,
    },
    {
      name: tr('dashboard.stats.nodes', 'Nodes'),
      resourceType: 'nodes' as ResourceType,
      // a namespace-scoped grant cannot read nodes: the scoped overview's 0 means "not counted", not "no nodes"
      value: overview?.scoped ? '—' : count(overview?.node_count),
      title: refusedTitle('nodes', 'Nodes'),
      icon: Server,
    },
  ]

  // Pod 상태 차트 데이터 (pods the caller may not list: no chart)
  const podStatusData = overview?.pod_status
    ? POD_PHASES.map((phase) => ({
      name: phase,
      value: overview?.pod_status?.[phase] ?? 0,
    }))
    : []

  // one bar per readiness, so every node is in one of them — a cordoned node counts by its readiness
  const nodeStatusChartData = nodes && Array.isArray(nodes)
    ? NODE_READINESS.map((readiness) => ({
      name: readiness,
      value: nodes.filter((node) => nodeReadiness(node.status) === readiness).length,
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
    <div className="page-scrolls space-y-8">
      <DashboardHeader
        clusterVersion={overview?.cluster_version}
        isRefreshing={isRefreshing}
        onRefresh={handleRefresh}
      />
      <RefreshFailure failure={refreshFailure} />

      <StatsGrid stats={stats} onStatClick={handleStatClick} />

      <DashboardPodNodeStatus
        podStatusData={podStatusData}
        nodeStatusChartData={nodeStatusChartData}
        onPodStatusClick={handlePodStatusClick}
        onNodeStatusClick={handleNodeStatusClick}
      />

      {promCluster.available ? (
        <PrometheusClusterMetrics
          title={tr('dashboard.clusterMetrics', 'Cluster Resource Utilization')}
          cpu={getClusterMetric('cpu')}
          memory={getClusterMetric('memory')}
          disk={getClusterMetric('disk')}
          podCount={getClusterMetric('pod_count')}
          podCapacity={getClusterMetric('pod_capacity')}
        />
      ) : promCluster.failure ? (
        <PrometheusClusterMetricsFailure title={tr('dashboard.clusterMetrics', 'Cluster Resource Utilization')} failure={promCluster.failure} />
      ) : null}

      <DashboardTopResources
        topResources={topResources}
        isLoading={isLoadingTopResources}
        isError={isTopResourcesError}
        error={topResourcesError}
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
        table={optimizationTable}
        isTableLoading={isLoadingOptimizationTable}
        tableError={optimizationTableError ? ((optimizationTableError as any)?.response?.data?.detail || (optimizationTableError as Error).message) : undefined}
        isStreaming={isOptimizationStreaming}
        copied={optimizationCopied}
        copyFailed={optimizationCopyFailed}
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
        windowMinutes={issuesWindowMinutes}
        setWindowMinutes={setIssuesWindowMinutes}
        defaultWindowMinutes={defaultIssuesWindowMinutes}
        searchQuery={issuesSearchQuery}
        setSearchQuery={setIssuesSearchQuery}
        isLoading={isIssuesLoading}
        error={issuesError ? ((issuesError as any)?.response?.data?.detail || (issuesError as Error).message) : undefined}
        generatedAt={issuesGeneratedAt}
        sortedIssues={sortedIssues}
        issuesByKind={issuesByKind}
        kinds={issueKinds}
        issuesSummary={issuesSummary}
        onOpenIssue={handleOpenIssue}
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
        serverPage={selectedResourceType === 'pods' ? { total: podPage?.total ?? 0, page: podPageNo, setPage: setPodPageNo } : undefined}
        namespaceCounts={selectedResourceType === 'namespaces' && Array.isArray(namespaces)
          ? namespaceCounts(
            namespaces.map((ns: { name: string }) => ns.name),
            namespacePods,
            isServicesError ? undefined : allServices,
            isDeploymentsError ? undefined : allDeployments,
          )
          : undefined}
      />
    </div>
  )
}
