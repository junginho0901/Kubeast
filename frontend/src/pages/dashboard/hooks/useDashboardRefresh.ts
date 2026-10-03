// Dashboard "Refresh" button — force-refreshes every cached query the
// page consumes. Encapsulates the isRefreshing flag, the bulk API
// fetch, and the React Query cache writes that keep the displayed
// numbers in sync. Extracted from Dashboard.tsx so the page no
// longer has to thread queryClient through; the hook owns it.

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { api } from '@/services/api'

export function useDashboardRefresh() {
  const [isRefreshing, setIsRefreshing] = useState(false)
  const queryClient = useQueryClient()

  const handleRefresh = async () => {
    setIsRefreshing(true)
    // 새로고침은 항상 강제 갱신 (force_refresh=true)
    try {
      // 메인 데이터를 직접 호출하고 캐시에 수동으로 업데이트

      // 먼저 네임스페이스 목록을 가져옴 (다른 API 호출에 필요)
      const namespacesData = await api.getNamespaces()

      // 나머지를 병렬로 호출 (네임스페이스별 리소스 조회 포함)
      const [overviewData, nodesData, allPodsData, allServicesData, allDeploymentsData, allPVCsData] = await Promise.all([
        api.getClusterOverview(true),
        api.getNodes(true),
        api.getAllPods(true),
        // 모든 네임스페이스의 Services 조회
        Promise.all(namespacesData.map((ns: any) => api.getServices(ns.name, true))).then(results => results.flat()),
        // 모든 네임스페이스의 Deployments 조회
        Promise.all(namespacesData.map((ns: any) => api.getDeployments(ns.name, true))).then(results => results.flat()),
        // 모든 네임스페이스의 PVCs 조회
        api.getPVCs(undefined, true),
      ])


      // 실제 데이터로 overview 보정 (타이밍 이슈 방지)
      const correctedOverview = {
        ...overviewData,
        total_pods: allPodsData.length,
        total_namespaces: namespacesData.length,
        total_services: allServicesData.length,
        total_deployments: allDeploymentsData.length,
        total_pvcs: allPVCsData.length,
      }


      // 캐시를 완전히 제거하고 새 데이터로 설정 (강제 리렌더링)
      queryClient.removeQueries({ queryKey: ['cluster-overview'] })
      queryClient.removeQueries({ queryKey: ['namespaces'] })
      queryClient.removeQueries({ queryKey: ['all-namespaces'] })
      queryClient.removeQueries({ queryKey: ['nodes'] })
      queryClient.removeQueries({ queryKey: ['modal-nodes'] })
      queryClient.removeQueries({ queryKey: ['all-pods'] })
      queryClient.removeQueries({ queryKey: ['all-services'] })
      queryClient.removeQueries({ queryKey: ['all-deployments'] })
      queryClient.removeQueries({ queryKey: ['all-pvcs'] })

      // 새 데이터로 캐시 설정 (보정된 overview 사용)
      queryClient.setQueryData(['cluster-overview'], correctedOverview)
      queryClient.setQueryData(['namespaces'], namespacesData)
      queryClient.setQueryData(['all-namespaces'], namespacesData)
      queryClient.setQueryData(['nodes'], nodesData)
      queryClient.setQueryData(['modal-nodes'], nodesData)
      queryClient.setQueryData(['all-pods'], allPodsData)
      queryClient.setQueryData(['all-services'], allServicesData)
      queryClient.setQueryData(['all-deployments'], allDeploymentsData)
      queryClient.setQueryData(['all-pvcs'], allPVCsData)

    } catch (error) {
      console.error('❌ 새로고침 실패:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  return { isRefreshing, handleRefresh }
}
