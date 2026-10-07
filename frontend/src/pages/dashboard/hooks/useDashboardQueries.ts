// Dashboard data fetching — every useQuery the page consumes plus
// the metricsUnavailable flag and its two side-effects (cancel
// in-flight top-resources queries when metrics flip unavailable;
// flip the flag when the top-resources query reports the
// metrics-server is gone). Extracted from Dashboard.tsx so the page
// no longer has to declare 12 useQuery calls inline; one hook call
// returns everything it needs.
//
// `enabled` flags depend on which modal is open / which stat card is
// selected — those are passed in as plain booleans so the hook stays
// pure (no UI state of its own besides metricsUnavailable, which is
// genuinely about the data layer).

import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import {
  api,
  TopResources,
  disableMetrics,
  isMetricsDisabled,
  isMetricsUnavailableError,
} from '@/services/api'
import { useCluster } from '@/contexts/ClusterContext'

import type { ResourceType } from '../types'

interface Args {
  selectedResourceType: ResourceType | null
  selectedPodStatus: string | null
  isIssuesModalOpen: boolean
  issuesWindowMinutes: number | null // null = server default
  includeRestartHistory: boolean
  isStorageModalOpen: boolean
  isOptimizationModalOpen: boolean
  optimizationNamespace: string
  storageActiveTab: 'pvcs' | 'pvs' | 'topology'
}

export function useDashboardQueries({
  selectedResourceType,
  selectedPodStatus,
  isIssuesModalOpen,
  issuesWindowMinutes,
  includeRestartHistory,
  isStorageModalOpen,
  isOptimizationModalOpen,
  optimizationNamespace,
  storageActiveTab,
}: Args) {
  const queryClient = useQueryClient()
  const { currentCluster } = useCluster()
  // Scope every dashboard query to the selected cluster. Without this the keys
  // are shared across clusters: a switch shows the previous cluster's cached
  // totals (and `placeholderData` queries keep them) until a background refetch.
  // Appended as a suffix so existing prefix-based invalidate/removeQueries that
  // reference e.g. ['all-pods'] still match. 'default' mirrors the server fallback.
  const ck = currentCluster || 'default'
  const [metricsUnavailable, setMetricsUnavailable] = useState(() => isMetricsDisabled())

  const { data: overview, isLoading } = useQuery({
    queryKey: ['cluster-overview', ck],
    queryFn: () => api.getClusterOverview(false), // 자동 갱신은 캐시 사용
    // k8s-service answers from its informer store (no API listing per poll).
    staleTime: 10000,
    refetchInterval: 15000,
  })

  // 네임스페이스 목록
  const { data: namespaces, isLoading: isLoadingNamespaces } = useQuery({
    queryKey: ['namespaces', ck],
    queryFn: () => api.getNamespaces(),
    enabled: selectedResourceType === 'namespaces',
  })

  // 전체 Pod 목록
  const { data: allPods, isLoading: isLoadingPods } = useQuery({
    queryKey: ['all-pods', ck],
    queryFn: () => api.getAllPods(false), // 자동 갱신은 캐시 사용
    enabled: selectedResourceType === 'pods' || selectedPodStatus !== null,
  })

  // Issues 모달 — k8s-service 가 파드·워크로드·노드·PVC·Warning 이벤트를 집계.
  const { data: clusterIssues, isLoading: isLoadingIssues, error: issuesError } = useQuery({
    queryKey: ['cluster-issues', ck, issuesWindowMinutes ?? 'default', includeRestartHistory],
    queryFn: () => api.getClusterIssues({ windowMinutes: issuesWindowMinutes ?? undefined, includeRestartHistory }),
    enabled: isIssuesModalOpen,
    staleTime: 10000,
    retry: false,
  })

  // Optimization 모달의 표 — requests/limits 대비 사용량 (window 는 서버 기본값).
  const { data: optimizationTable, isLoading: isLoadingOptimizationTable, error: optimizationTableError } = useQuery({
    queryKey: ['cluster-optimization', ck, optimizationNamespace],
    queryFn: () => api.getClusterOptimization(optimizationNamespace),
    enabled: isOptimizationModalOpen && !!optimizationNamespace,
    staleTime: 30000,
    retry: false,
  })

  // 전체 Services 목록 (모든 네임스페이스)
  const { data: allNamespaces, isLoading: isLoadingAllNamespaces } = useQuery({
    queryKey: ['all-namespaces', ck],
    queryFn: () => api.getNamespaces(),
    enabled:
      selectedResourceType === 'services' ||
      selectedResourceType === 'deployments' ||
      isIssuesModalOpen ||
      isStorageModalOpen ||
      isOptimizationModalOpen,
  })

  const { data: allServices, isLoading: isLoadingServices } = useQuery({
    queryKey: ['all-services', ck],
    queryFn: async () => {
      if (!allNamespaces || !Array.isArray(allNamespaces)) return []
      const services = await Promise.all(
        allNamespaces.map((ns: any) => api.getServices(ns.name)),
      )
      return services.flat()
    },
    enabled: selectedResourceType === 'services' && !!allNamespaces,
  })

  // 전체 Deployments 목록
  const { data: allDeployments, isLoading: isLoadingDeployments } = useQuery({
    queryKey: ['all-deployments', ck],
    queryFn: async () => {
      if (!allNamespaces || !Array.isArray(allNamespaces)) return []
      const deployments = await Promise.all(
        allNamespaces.map((ns: any) => api.getDeployments(ns.name)),
      )
      return deployments.flat()
    },
    enabled: (selectedResourceType === 'deployments' || isStorageModalOpen) && !!allNamespaces,
  })

  // 전체 PVC 목록 — Storage 모달이 열려 있을 때는 사용률(Prometheus)까지.
  const { data: allPVCs, isLoading: isLoadingPVCs } = useQuery({
    queryKey: ['all-pvcs', ck, isStorageModalOpen ? 'usage' : 'plain'],
    queryFn: () => api.getPVCs(undefined, false, isStorageModalOpen),
    enabled: selectedResourceType === 'pvcs' || isStorageModalOpen,
  })

  // 전체 PV 목록 (스토리지 분석용)
  const { data: allPVs, isLoading: isLoadingPVs } = useQuery({
    queryKey: ['all-pvs', ck],
    queryFn: () => api.getPVs(),
    enabled: isStorageModalOpen,
  })

  // 스토리지 토폴로지 (선택 탭에서만 로드)
  const {
    data: storageTopology,
    isLoading: isLoadingStorageTopology,
    isError: isStorageTopologyError,
    error: storageTopologyError,
  } = useQuery({
    queryKey: ['storage-topology', ck],
    queryFn: () => api.getStorageTopology(),
    enabled: isStorageModalOpen && storageActiveTab === 'topology',
    retry: false,
    staleTime: 30000,
    refetchOnWindowFocus: false,
  })

  // 노드 목록 (차트 표시용 - 항상 가져오기)
  const { data: nodes } = useQuery({
    queryKey: ['nodes', ck],
    queryFn: () => api.getNodes(false), // 자동 갱신은 캐시 사용
    staleTime: 30000,
    refetchInterval: 60000,
  })

  // Top 리소스 사용 파드/노드 (5초마다 갱신)
  const {
    data: topResources,
    isLoading: isLoadingTopResources,
    isError: isTopResourcesError,
    error: topResourcesError,
  } = useQuery<TopResources>({
    queryKey: ['top-resources', ck],
    queryFn: async () => {
      const result = await api.getTopResources(5, 3)
      // 백엔드에서 빈 배열을 반환한 경우(일시적 실패) 이전 데이터 유지를 위해
      // 유효한 데이터가 있는지 확인
      const hasValidData = (result.top_pods && result.top_pods.length > 0) ||
                          (result.top_nodes && result.top_nodes.length > 0)

      if (!hasValidData) {
        // The k8s-service answers 200 with empty lists and the metrics API
        // error when the cluster has no metrics-server ("could not find the
        // requested resource"). Surface that as the metrics-unavailable state
        // (same shape as the 503 the other metrics endpoints raise) instead of
        // a generic fetch failure.
        const apiErr = `${result.pod_metrics_error || ''} ${result.node_metrics_error || ''}`
        if (/could not find the requested resource/i.test(apiErr)) {
          const unavailable: any = new Error('metrics server not available')
          unavailable.response = { status: 503, data: { code: 'metrics_unavailable' } }
          throw unavailable
        }
        // 빈 데이터면 에러를 throw하여 React Query가 이전 데이터를 유지하도록
        // placeholderData가 이전 데이터를 반환하도록 함
        throw new Error('No valid metrics data available')
      }

      return result
    },
    enabled: !metricsUnavailable && !isMetricsDisabled(),
    staleTime: 5000, // 5초간 fresh 상태 유지
    refetchInterval: () => {
      if (metricsUnavailable || isMetricsDisabled()) return false
      return 5000
    },
    placeholderData: (previousData, previousQuery) => {
      // Keep the prior frame to avoid flicker on the 5s refetch — but ONLY within
      // the same cluster. The key's 2nd segment is the cluster; if it differs,
      // this is a cluster switch and the previous cluster's top-N must NOT bleed
      // onto the new one (which may not even run metrics-server).
      if (previousQuery && previousQuery.queryKey?.[1] !== ck) return undefined
      if (previousData && (
        (previousData.top_pods && previousData.top_pods.length > 0) ||
        (previousData.top_nodes && previousData.top_nodes.length > 0)
      )) {
        return previousData
      }
      return undefined
    },
    retry: (failureCount, error) => {
      if (isMetricsUnavailableError(error)) return false
      return failureCount < 1
    },
    retryDelay: 1000,
    gcTime: 60000,
  })

  useEffect(() => {
    if (isMetricsUnavailableError(topResourcesError)) {
      disableMetrics()
      setMetricsUnavailable(true)
    }
  }, [topResourcesError])

  useEffect(() => {
    if (metricsUnavailable) {
      queryClient.cancelQueries({ queryKey: ['top-resources', ck] })
    }
  }, [metricsUnavailable, queryClient, ck])

  // 노드 목록 (모달용)
  const { data: modalNodes, isLoading: isLoadingNodes } = useQuery({
    queryKey: ['modal-nodes', ck],
    queryFn: () => api.getNodes(false), // 자동 갱신은 캐시 사용
    enabled: selectedResourceType === 'nodes',
  })

  return {
    overview,
    isLoading,
    namespaces,
    isLoadingNamespaces,
    allPods,
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
  }
}
