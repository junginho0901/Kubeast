import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, TopResources } from '@/services/api'
import {
  Server,
  Box,
  Database,
  HardDrive,
  TrendingUp,
  AlertCircle,
  RefreshCw,
  X,
  CheckCircle,
  XCircle,
  Search,
  Info
} from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { useState, useEffect } from 'react'
import { ModalOverlay } from '@/components/ModalOverlay'

type ResourceType = 'namespaces' | 'pods' | 'services' | 'deployments' | 'pvcs' | 'nodes'

export default function Dashboard() {
  const queryClient = useQueryClient()
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [selectedResourceType, setSelectedResourceType] = useState<ResourceType | null>(null)
  const [modalSearchQuery, setModalSearchQuery] = useState<string>('')
  const [selectedPodStatus, setSelectedPodStatus] = useState<string | null>(null)
  const [selectedNodeStatus, setSelectedNodeStatus] = useState<string | null>(null)
  const [selectedNode, setSelectedNode] = useState<any | null>(null)

  const { data: overview, isLoading } = useQuery({
    queryKey: ['cluster-overview'],
    queryFn: () => api.getClusterOverview(false), // 자동 갱신은 캐시 사용
    staleTime: 30000,
    refetchInterval: 60000,
  })

  // 네임스페이스 목록
  const { data: namespaces, isLoading: isLoadingNamespaces } = useQuery({
    queryKey: ['namespaces'],
    queryFn: () => api.getNamespaces(false), // 자동 갱신은 캐시 사용
    enabled: selectedResourceType === 'namespaces',
  })

  // 전체 Pod 목록
  const { data: allPods, isLoading: isLoadingPods } = useQuery({
    queryKey: ['all-pods'],
    queryFn: () => api.getAllPods(false), // 자동 갱신은 캐시 사용
    enabled: selectedResourceType === 'pods' || selectedPodStatus !== null,
  })

  // 전체 Services 목록 (모든 네임스페이스)
  const { data: allNamespaces, isLoading: isLoadingAllNamespaces } = useQuery({
    queryKey: ['all-namespaces'],
    queryFn: () => api.getNamespaces(false), // 자동 갱신은 캐시 사용
    enabled: selectedResourceType === 'services' || selectedResourceType === 'deployments',
  })

  const { data: allServices, isLoading: isLoadingServices } = useQuery({
    queryKey: ['all-services'],
    queryFn: async () => {
      if (!allNamespaces || !Array.isArray(allNamespaces)) return []
      const services = await Promise.all(
        allNamespaces.map((ns: any) => api.getServices(ns.name))
      )
      return services.flat()
    },
    enabled: selectedResourceType === 'services' && !!allNamespaces,
  })

  // 전체 Deployments 목록
  const { data: allDeployments, isLoading: isLoadingDeployments } = useQuery({
    queryKey: ['all-deployments'],
    queryFn: async () => {
      if (!allNamespaces || !Array.isArray(allNamespaces)) return []
      const deployments = await Promise.all(
        allNamespaces.map((ns: any) => api.getDeployments(ns.name))
      )
      return deployments.flat()
    },
    enabled: selectedResourceType === 'deployments' && !!allNamespaces,
  })

  // 전체 PVC 목록
  const { data: allPVCs, isLoading: isLoadingPVCs } = useQuery({
    queryKey: ['all-pvcs'],
    queryFn: () => api.getPVCs(),
    enabled: selectedResourceType === 'pvcs',
  })

  // 노드 목록 (차트 표시용 - 항상 가져오기)
  const { data: nodes } = useQuery({
    queryKey: ['nodes'],
    queryFn: () => api.getNodes(false), // 자동 갱신은 캐시 사용
    staleTime: 30000,
    refetchInterval: 60000,
  })

  // Top 리소스 사용 파드/노드 (5초마다 갱신)
  const {
    data: topResources,
    isLoading: isLoadingTopResources,
    isError: isTopResourcesError
  } = useQuery<TopResources>({
    queryKey: ['top-resources'],
    queryFn: async () => {
      const result = await api.getTopResources(5, 3)
      // 백엔드에서 빈 배열을 반환한 경우(일시적 실패) 이전 데이터 유지를 위해
      // 유효한 데이터가 있는지 확인
      const hasValidData = (result.top_pods && result.top_pods.length > 0) ||
                          (result.top_nodes && result.top_nodes.length > 0)
      
      if (!hasValidData) {
        // 빈 데이터면 에러를 throw하여 React Query가 이전 데이터를 유지하도록
        // placeholderData가 이전 데이터를 반환하도록 함
        throw new Error('No valid metrics data available')
      }
      
      return result
    },
    staleTime: 5000, // 5초간 fresh 상태 유지
    refetchInterval: 5000, // 5초마다 백그라운드 갱신
    placeholderData: (previousData) => {
      // 이전 데이터가 있고 유효한 경우에만 유지
      // 에러 발생 시에도 이전 데이터를 유지하여 깜빡임 방지
      if (previousData && (
        (previousData.top_pods && previousData.top_pods.length > 0) ||
        (previousData.top_nodes && previousData.top_nodes.length > 0)
      )) {
        return previousData
      }
      return undefined
    },
    retry: 1, // 실패 시 1번만 재시도
    retryDelay: 1000, // 1초 대기 후 재시도
    // 에러 발생 시에도 이전 데이터를 유지
    gcTime: 60000, // 캐시 유지 시간 (기본값보다 길게)
  })

  // 노드 목록 (모달용)
  const { data: modalNodes, isLoading: isLoadingNodes } = useQuery({
    queryKey: ['modal-nodes'],
    queryFn: () => api.getNodes(false), // 자동 갱신은 캐시 사용
    enabled: selectedResourceType === 'nodes',
  })

  // 선택된 노드의 상세 정보
  const { data: nodeDetail, isLoading: isLoadingNodeDetail } = useQuery({
    queryKey: ['node-detail', selectedNode?.name],
    queryFn: () => api.describeNode(selectedNode.name),
    enabled: !!selectedNode,
  })

  // 컴포넌트 상태
  const { data: componentStatuses, isLoading: isLoadingComponents } = useQuery({
    queryKey: ['component-statuses'],
    queryFn: api.getComponentStatuses,
    enabled: !!selectedNode,
  })

  const handleRefresh = async () => {
    console.log('🔄 새로고침 시작...')
    setIsRefreshing(true)
    // 새로고침은 항상 강제 갱신 (force_refresh=true)
    try {
      // 메인 데이터를 직접 호출하고 캐시에 수동으로 업데이트
      console.log('📡 API 호출 중 (force_refresh=true)...')

      // 먼저 네임스페이스 목록을 가져옴 (다른 API 호출에 필요)
      const namespacesData = await api.getNamespaces(true)

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

      console.log('✅ API 응답 받음:', {
        overview: overviewData,
        overviewPods: overviewData?.total_pods,
        namespaces: namespacesData?.length,
        nodes: nodesData?.length,
        pods: allPodsData?.length,
        services: allServicesData?.length,
        deployments: allDeploymentsData?.length,
        pvcs: allPVCsData?.length
      })
      console.log('📊 현재 화면에 표시중인 overview:', overview)

      // 실제 데이터로 overview 보정 (타이밍 이슈 방지)
      const correctedOverview = {
        ...overviewData,
        total_pods: allPodsData.length,
        total_namespaces: namespacesData.length,
        total_services: allServicesData.length,
        total_deployments: allDeploymentsData.length,
        total_pvcs: allPVCsData.length,
      }

      console.log('✏️  보정된 overview:', correctedOverview)

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

      console.log('💾 React Query 캐시 업데이트 완료')
    } catch (error) {
      console.error('❌ 새로고침 실패:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const handleStatClick = (type: ResourceType) => {
    setSelectedResourceType(type)
  }

  const handleCloseModal = () => {
    setSelectedResourceType(null)
    setSelectedPodStatus(null)
    setSelectedNodeStatus(null)
    setModalSearchQuery('')
  }

  const handleNodeClick = (node: any) => {
    setSelectedNode(node)
  }

  const handleCloseNodeDetail = () => {
    setSelectedNode(null)
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
        if (selectedResourceType) {
          setSelectedResourceType(null)
          setSelectedPodStatus(null)
          setSelectedNodeStatus(null)
          setModalSearchQuery('')
        }
        if (selectedNode) {
          setSelectedNode(null)
        }
      }
    }
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('keydown', handleEscape)
    }
  }, [selectedResourceType, selectedNode])

  // 선택된 리소스 타입에 해당하는 stat 정보 가져오기
  const getSelectedStat = () => {
    const resourceTypeMap: Record<string, ResourceType> = {
      '네임스페이스': 'namespaces',
      'Pods': 'pods',
      'Services': 'services',
      'Deployments': 'deployments',
      'PVCs': 'pvcs',
      'Nodes': 'nodes',
    }
    return stats.find(s => resourceTypeMap[s.name] === selectedResourceType)
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

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[300px]">
        <RefreshCw className="w-8 h-8 text-primary-400 animate-spin mb-4" />
        <p className="text-slate-400">데이터를 불러오는 중...</p>
      </div>
    )
  }

  const stats = [
    {
      name: '네임스페이스',
      value: overview?.total_namespaces || 0,
      icon: Server,
      color: 'text-blue-400',
      bgColor: 'bg-blue-500/10',
    },
    {
      name: 'Pods',
      value: overview?.total_pods || 0,
      icon: Box,
      color: 'text-green-400',
      bgColor: 'bg-green-500/10',
    },
    {
      name: 'Services',
      value: overview?.total_services || 0,
      icon: Database,
      color: 'text-purple-400',
      bgColor: 'bg-purple-500/10',
    },
    {
      name: 'Deployments',
      value: overview?.total_deployments || 0,
      icon: TrendingUp,
      color: 'text-yellow-400',
      bgColor: 'bg-yellow-500/10',
    },
    {
      name: 'PVCs',
      value: overview?.total_pvcs || 0,
      icon: HardDrive,
      color: 'text-pink-400',
      bgColor: 'bg-pink-500/10',
    },
    {
      name: 'Nodes',
      value: overview?.node_count || 0,
      icon: Server,
      color: 'text-cyan-400',
      bgColor: 'bg-cyan-500/10',
    },
  ]

  // Pod 상태 차트 데이터
  const podStatusData = overview?.pod_status
    ? Object.entries(overview.pod_status).map(([name, value]) => ({
      name,
      value,
    }))
    : []

  // 노드 상태 차트 데이터
  const nodeStatusData = nodes && Array.isArray(nodes)
    ? nodes.reduce((acc: Record<string, number>, node) => {
      const status = node.status || 'Unknown'
      acc[status] = (acc[status] || 0) + 1
      return acc
    }, {})
    : {}

  const nodeStatusChartData = Object.entries(nodeStatusData).map(([name, value]) => ({
    name,
    value,
  }))

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">클러스터 대시보드</h1>
          <p className="mt-2 text-slate-400">
            Kubernetes 클러스터 전체 현황을 한눈에 확인하세요
          </p>
          {overview?.cluster_version && (
            <p className="mt-1 text-sm text-slate-500">
              클러스터 버전: {overview.cluster_version}
            </p>
          )}
        </div>
        <button
          onClick={handleRefresh}
          disabled={isRefreshing}
          title="새로고침 (강제 갱신)"
          className="btn btn-secondary flex items-center gap-2"
        >
          <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          새로고침
        </button>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {stats.map((stat) => {
          const resourceTypeMap: Record<string, ResourceType> = {
            '네임스페이스': 'namespaces',
            'Pods': 'pods',
            'Services': 'services',
            'Deployments': 'deployments',
            'PVCs': 'pvcs',
            'Nodes': 'nodes',
          }
          const resourceType = resourceTypeMap[stat.name]

          return (
            <button
              key={stat.name}
              onClick={() => handleStatClick(resourceType)}
              className="card hover:border-primary-500 transition-colors text-left cursor-pointer"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-400">{stat.name}</p>
                  <p className="mt-2 text-3xl font-bold text-white">{stat.value}</p>
                </div>
                <div className={`p-3 rounded-lg ${stat.bgColor}`}>
                  <stat.icon className={`w-6 h-6 ${stat.color}`} />
                </div>
              </div>
            </button>
          )
        })}
      </div>

      {/* Charts Grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Pod Status Chart */}
        {podStatusData.length > 0 && (
          <div className="card">
            <h2 className="text-xl font-bold text-white mb-4">Pod 상태</h2>
            <p className="text-sm text-slate-400 mb-4">클릭하여 해당 상태의 Pod 목록 보기</p>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart
                data={podStatusData}
                onClick={(data) => {
                  if (data && data.activeLabel) {
                    handlePodStatusClick(data.activeLabel)
                  }
                }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis
                  dataKey="name"
                  stroke="#94a3b8"
                  style={{ cursor: 'pointer' }}
                />
                <YAxis stroke="#94a3b8" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#1e293b',
                    border: '1px solid #334155',
                    borderRadius: '8px'
                  }}
                  cursor={{ fill: 'rgba(14, 165, 233, 0.1)' }}
                />
                <Bar
                  dataKey="value"
                  fill="#0ea5e9"
                  cursor="pointer"
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Node Status Chart */}
        {nodeStatusChartData.length > 0 && (
          <div className="card">
            <h2 className="text-xl font-bold text-white mb-4">노드 상태</h2>
            <p className="text-sm text-slate-400 mb-4">클릭하여 해당 상태의 노드 목록 보기</p>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart
                data={nodeStatusChartData}
                onClick={(data) => {
                  if (data && data.activeLabel) {
                    handleNodeStatusClick(data.activeLabel)
                  }
                }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis
                  dataKey="name"
                  stroke="#94a3b8"
                  style={{ cursor: 'pointer' }}
                />
                <YAxis stroke="#94a3b8" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#1e293b',
                    border: '1px solid #334155',
                    borderRadius: '8px'
                  }}
                  cursor={{ fill: 'rgba(6, 182, 212, 0.1)' }}
                />
                <Bar
                  dataKey="value"
                  fill="#06b6d4"
                  fillOpacity={0.8}
                  cursor="pointer"
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Top 리소스 사용 파드/노드 */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Top 파드 */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-white">리소스 사용 Top 5 파드</h2>
            <p className="text-xs text-slate-400">5초마다 자동 갱신</p>
          </div>
          {isLoadingTopResources && !topResources ? (
            // 초기 로딩: 스켈레톤 표시
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="p-4 bg-slate-700 rounded-lg animate-pulse">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="w-8 h-8 rounded-full bg-slate-600" />
                    <div className="flex-1 space-y-2">
                      <div className="h-4 bg-slate-600 rounded w-3/4" />
                      <div className="h-3 bg-slate-600 rounded w-1/2" />
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-6 mt-2">
                    <div className="h-3 bg-slate-600 rounded w-16" />
                    <div className="h-3 bg-slate-600 rounded w-20" />
                  </div>
                </div>
              ))}
            </div>
          ) : isTopResourcesError && !topResources?.top_pods ? (
            // 에러 상태: 이전 데이터가 없을 때만 에러 표시
            <div className="text-center py-12">
              <div className="flex flex-col items-center gap-2">
                <AlertCircle className="w-8 h-8 text-red-400" />
                <p className="text-slate-400">데이터를 가져오는데 실패했습니다</p>
              </div>
            </div>
          ) : topResources?.top_pods && topResources.top_pods.length > 0 ? (
            // 데이터가 있을 때: 데이터 표시 (백그라운드 갱신 중에도 이전 데이터 유지)
            <div className="space-y-3">
              {topResources.top_pods.map((pod, index) => (
                <div key={`${pod.namespace}-${pod.name}`} className="p-4 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary-500/20">
                      <span className="text-primary-400 font-bold text-sm">#{index + 1}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="font-medium text-white truncate" title={pod.name}>
                        {pod.name}
                      </h3>
                      <p className="text-sm text-slate-400">{pod.namespace}</p>
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-6 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400">CPU:</span>
                      <span className="text-green-400 font-mono font-medium">{pod.cpu}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400">Memory:</span>
                      <span className="text-blue-400 font-mono font-medium">{pod.memory}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : topResources?.pod_error ? (
            // 메트릭 수집 실패 (노드 메트릭은 있을 수 있음)
            <div className="text-center py-12">
              <div className="flex flex-col items-center gap-2">
                <AlertCircle className="w-8 h-8 text-yellow-400" />
                <p className="text-slate-400">Pod 메트릭을 가져오는 데 실패했습니다</p>
                <p className="text-xs text-slate-500">metrics-server 상태를 확인해주세요</p>
              </div>
            </div>
          ) : (
            // 데이터가 없을 때
            <div className="text-center py-12">
              <p className="text-slate-400">리소스 사용 데이터가 없습니다</p>
            </div>
          )}
        </div>

        {/* Top 노드 */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-white">리소스 사용 Top 3 노드</h2>
            <p className="text-xs text-slate-400">5초마다 자동 갱신</p>
          </div>
          {isLoadingTopResources && !topResources ? (
            // 초기 로딩: 스켈레톤 표시
            <div className="space-y-4">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="space-y-3 p-3 bg-slate-700 rounded-lg animate-pulse">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-slate-600" />
                    <div className="flex-1 space-y-2">
                      <div className="h-4 bg-slate-600 rounded w-1/2" />
                      <div className="h-3 bg-slate-600 rounded w-1/3" />
                    </div>
                  </div>
                  <div className="space-y-2 pl-11">
                    <div className="flex items-center justify-between text-xs">
                      <div className="h-3 bg-slate-600 rounded w-10" />
                      <div className="h-3 bg-slate-600 rounded w-12" />
                    </div>
                    <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                      <div className="h-full bg-slate-600 w-1/2" />
                    </div>
                  </div>
                  <div className="space-y-2 pl-11">
                    <div className="flex items-center justify-between text-xs">
                      <div className="h-3 bg-slate-600 rounded w-12" />
                      <div className="h-3 bg-slate-600 rounded w-10" />
                    </div>
                    <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                      <div className="h-full bg-slate-600 w-1/3" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : isTopResourcesError && !topResources?.top_nodes ? (
            // 에러 상태: 이전 데이터가 없을 때만 에러 표시
            <div className="text-center py-12">
              <div className="flex flex-col items-center gap-2">
                <AlertCircle className="w-8 h-8 text-red-400" />
                <p className="text-slate-400">데이터를 가져오는데 실패했습니다</p>
              </div>
            </div>
          ) : topResources?.top_nodes && topResources.top_nodes.length > 0 ? (
            // 데이터가 있을 때: 데이터 표시 (백그라운드 갱신 중에도 이전 데이터 유지)
            <div className="space-y-4">
              {topResources.top_nodes.map((node, index) => {
                const cpuPercent = parseFloat(node.cpu_percent)
                const memoryPercent = parseFloat(node.memory_percent)

                return (
                  <div key={node.name} className="space-y-3">
                    <div className="flex items-center gap-3">
                      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cyan-500/20">
                        <span className="text-cyan-400 font-bold text-sm">#{index + 1}</span>
                      </div>
                      <div className="flex-1">
                        <h3 className="font-medium text-white">{node.name}</h3>
                        <div className="flex items-center gap-4 text-sm text-slate-400 mt-1">
                          <span>CPU: {node.cpu}</span>
                          <span>Memory: {node.memory}</span>
                        </div>
                      </div>
                    </div>

                    {/* CPU 사용량 막대 */}
                    <div className="space-y-1 pl-11">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-slate-400">CPU</span>
                        <span className={`font-medium ${cpuPercent >= 80 ? 'text-red-400' :
                            cpuPercent >= 60 ? 'text-yellow-400' :
                              'text-green-400'
                          }`}>
                          {node.cpu_percent}
                        </span>
                      </div>
                      <div className="w-full h-2 bg-slate-600 rounded-full overflow-hidden">
                        <div
                          className={`h-full transition-all duration-300 ${cpuPercent >= 80 ? 'bg-red-500' :
                              cpuPercent >= 60 ? 'bg-yellow-500' :
                                'bg-green-500'
                            }`}
                          style={{ width: `${Math.min(cpuPercent, 100)}%` }}
                        />
                      </div>
                    </div>

                    {/* Memory 사용량 막대 */}
                    <div className="space-y-1 pl-11">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-slate-400">Memory</span>
                        <span className={`font-medium ${memoryPercent >= 80 ? 'text-red-400' :
                            memoryPercent >= 60 ? 'text-yellow-400' :
                              'text-blue-400'
                          }`}>
                          {node.memory_percent}
                        </span>
                      </div>
                      <div className="w-full h-2 bg-slate-600 rounded-full overflow-hidden">
                        <div
                          className={`h-full transition-all duration-300 ${memoryPercent >= 80 ? 'bg-red-500' :
                              memoryPercent >= 60 ? 'bg-yellow-500' :
                                'bg-blue-500'
                            }`}
                          style={{ width: `${Math.min(memoryPercent, 100)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : topResources?.node_error ? (
            // 메트릭 수집 실패 (파드 메트릭은 있을 수 있음)
            <div className="text-center py-12">
              <div className="flex flex-col items-center gap-2">
                <AlertCircle className="w-8 h-8 text-yellow-400" />
                <p className="text-slate-400">노드 메트릭을 가져오는 데 실패했습니다</p>
                <p className="text-xs text-slate-500">metrics-server 상태를 확인해주세요</p>
              </div>
            </div>
          ) : (
            // 데이터가 없을 때
            <div className="text-center py-12">
              <p className="text-slate-400">리소스 사용 데이터가 없습니다</p>
            </div>
          )}
        </div>
      </div>

      {/* 노드 상세 정보 - 별도 카드 */}
      {nodes && Array.isArray(nodes) && nodes.length > 0 && (
        <div className="card">
          <h2 className="text-xl font-bold text-white mb-4">노드 목록</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 max-h-[400px] overflow-y-auto">
            {nodes.map((node) => (
              <button
                key={node.name}
                onClick={() => handleNodeClick(node)}
                className="p-3 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors text-left cursor-pointer"
              >
                <div className="flex items-start gap-2 mb-2">
                  {node.status === 'Ready' ? (
                    <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0 mt-0.5" />
                  ) : (
                    <XCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate" title={node.name}>
                      {node.name}
                    </p>
                  </div>
                  <Info className="w-4 h-4 text-slate-400 flex-shrink-0" />
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-slate-400">
                    <span className="font-medium">Version:</span> {node.version || 'N/A'}
                  </p>
                  {node.roles && node.roles.length > 0 && (
                    <p className="text-xs text-slate-400">
                      <span className="font-medium">Roles:</span> {node.roles.join(', ')}
                    </p>
                  )}
                  {node.internal_ip && (
                    <p className="text-xs text-slate-400">
                      <span className="font-medium">IP:</span> {node.internal_ip}
                    </p>
                  )}
                </div>
                <div className="mt-2">
                  <span className={`badge text-xs ${node.status === 'Ready' ? 'badge-success' : 'badge-error'
                    }`}>
                    {node.status}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Quick Actions */}
      <div className="card">
        <h2 className="text-xl font-bold text-white mb-4">빠른 작업</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <button className="btn btn-secondary text-left">
            <div className="flex items-center gap-3">
              <AlertCircle className="w-5 h-5 text-yellow-400" />
              <div>
                <div className="font-medium">이슈 확인</div>
                <div className="text-xs text-slate-400">문제가 있는 리소스 찾기</div>
              </div>
            </div>
          </button>
          <button className="btn btn-secondary text-left">
            <div className="flex items-center gap-3">
              <TrendingUp className="w-5 h-5 text-green-400" />
              <div>
                <div className="font-medium">최적화 제안</div>
                <div className="text-xs text-slate-400">AI 기반 리소스 최적화</div>
              </div>
            </div>
          </button>
          <button className="btn btn-secondary text-left">
            <div className="flex items-center gap-3">
              <Database className="w-5 h-5 text-blue-400" />
              <div>
                <div className="font-medium">스토리지 분석</div>
                <div className="text-xs text-slate-400">PV/PVC 사용 현황</div>
              </div>
            </div>
          </button>
        </div>
      </div>

      {/* 리소스 상세 모달 */}
      {selectedResourceType && (
        <ModalOverlay onClose={handleCloseModal}>
          <div
            className="bg-slate-800 rounded-lg max-w-4xl w-full h-[80vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 모달 헤더 */}
            {(() => {
              const selectedStat = getSelectedStat()
              const Icon = selectedStat?.icon || Box
              return (
                <div className="p-6 border-b border-slate-700">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                      {selectedStat && (
                        <div className={`p-2 rounded-lg ${selectedStat.bgColor || 'bg-slate-700'}`}>
                          <Icon className={`w-5 h-5 ${selectedStat.color || 'text-white'}`} />
                        </div>
                      )}
                      <div>
                        <h2 className="text-xl font-bold text-white">
                          {selectedStat?.name || selectedResourceType}
                        </h2>
                        <p className="text-sm text-slate-400">
                          {isLoadingResource() ? '로딩 중...' : `총 ${getResourceCount()}개`}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={handleCloseModal}
                      className="p-2 hover:bg-slate-700 rounded-lg transition-colors"
                    >
                      <X className="w-5 h-5 text-slate-400" />
                    </button>
                  </div>
                  {/* 검색창 - 헤더 내부 */}
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                      type="text"
                      placeholder="검색..."
                      value={modalSearchQuery}
                      onChange={(e) => setModalSearchQuery(e.target.value)}
                      className="w-full h-10 pl-10 pr-10 bg-slate-700 text-white rounded-lg border border-slate-600 focus:outline-none focus:border-primary-500 transition-colors"
                    />
                    {modalSearchQuery && (
                      <button
                        onClick={() => setModalSearchQuery('')}
                        className="absolute right-3 top-1/2 transform -translate-y-1/2 p-1 hover:bg-slate-600 rounded transition-colors"
                      >
                        <X className="w-4 h-4 text-slate-400" />
                      </button>
                    )}
                  </div>
                </div>
              )
            })()}

            {/* 모달 내용 */}
            <div className="flex-1 overflow-y-auto p-6">
              {isLoadingResource() ? (
                <div className="flex flex-col items-center justify-center h-full min-h-[300px]">
                  <RefreshCw className="w-8 h-8 text-primary-400 animate-spin mb-4" />
                  <p className="text-slate-400">데이터를 불러오는 중...</p>
                </div>
              ) : (
                <>
                  {selectedResourceType === 'namespaces' && (
                    <div className="space-y-2">
                      {filteredResources.length > 0 ? (
                        filteredResources.map((ns) => (
                          <div key={ns.name} className="p-4 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors">
                            <div className="flex items-center justify-between">
                              <div>
                                <h3 className="font-medium text-white">{ns.name}</h3>
                                <p className="text-sm text-slate-400 mt-1">
                                  Pods: {ns.resource_count?.pods || 0} |
                                  Services: {ns.resource_count?.services || 0} |
                                  Deployments: {ns.resource_count?.deployments || 0}
                                </p>
                              </div>
                              <span className={`badge ${ns.status === 'Active' ? 'badge-success' : 'badge-warning'
                                }`}>
                                {ns.status}
                              </span>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="text-center py-12">
                          <p className="text-slate-400">
                            {modalSearchQuery ? '검색 결과가 없습니다' : '네임스페이스가 없습니다'}
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {selectedResourceType === 'pods' && (
                    <div className="space-y-2">
                      {filteredResources.length > 0 ? (
                        filteredResources.map((pod) => (
                          <div key={`${pod.namespace}-${pod.name}`} className="p-4 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-3">
                                {pod.phase === 'Running' ? (
                                  <CheckCircle className="w-5 h-5 text-green-400" />
                                ) : (
                                  <XCircle className="w-5 h-5 text-red-400" />
                                )}
                                <div>
                                  <h3 className="font-medium text-white">{pod.name}</h3>
                                  <p className="text-sm text-slate-400">{pod.namespace}</p>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className={`badge ${pod.phase === 'Running' ? 'badge-success' : 'badge-warning'
                                  }`}>
                                  {pod.phase}
                                </span>
                                {pod.node_name && (
                                  <span className="text-xs text-slate-400">{pod.node_name}</span>
                                )}
                              </div>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="text-center py-12">
                          <p className="text-slate-400">
                            {modalSearchQuery ? '검색 결과가 없습니다' : 'Pod가 없습니다'}
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {selectedResourceType === 'services' && (
                    <div className="space-y-2">
                      {filteredResources.length > 0 ? (
                        filteredResources.map((svc) => (
                          <div key={`${svc.namespace}-${svc.name}`} className="p-4 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors">
                            <div className="flex items-center justify-between">
                              <div>
                                <h3 className="font-medium text-white">{svc.name}</h3>
                                <p className="text-sm text-slate-400 mt-1">
                                  {svc.namespace} | Type: {svc.type} | Cluster IP: {svc.cluster_ip || 'None'}
                                </p>
                              </div>
                              <span className="badge badge-info">{svc.type}</span>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="text-center py-12">
                          <p className="text-slate-400">
                            {modalSearchQuery ? '검색 결과가 없습니다' : 'Service가 없습니다'}
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {selectedResourceType === 'deployments' && (
                    <div className="space-y-2">
                      {filteredResources.length > 0 ? (
                        filteredResources.map((deploy) => (
                          <div key={`${deploy.namespace}-${deploy.name}`} className="p-4 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors">
                            <div className="flex items-center justify-between">
                              <div>
                                <h3 className="font-medium text-white">{deploy.name}</h3>
                                <p className="text-sm text-slate-400 mt-1">
                                  {deploy.namespace} | Replicas: {deploy.ready_replicas}/{deploy.replicas}
                                </p>
                              </div>
                              <span className={`badge ${deploy.ready_replicas === deploy.replicas ? 'badge-success' : 'badge-warning'
                                }`}>
                                {deploy.status}
                              </span>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="text-center py-12">
                          <p className="text-slate-400">
                            {modalSearchQuery ? '검색 결과가 없습니다' : 'Deployment가 없습니다'}
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {selectedResourceType === 'pvcs' && (
                    <div className="space-y-2">
                      {filteredResources.length > 0 ? (
                        filteredResources.map((pvc) => (
                          <div key={`${pvc.namespace}-${pvc.name}`} className="p-4 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors">
                            <div className="flex items-center justify-between">
                              <div>
                                <h3 className="font-medium text-white">{pvc.name}</h3>
                                <p className="text-sm text-slate-400 mt-1">
                                  {pvc.namespace} | {pvc.capacity || 'N/A'} | {pvc.storage_class || 'N/A'}
                                </p>
                              </div>
                              <span className={`badge ${pvc.status === 'Bound' ? 'badge-success' : 'badge-warning'
                                }`}>
                                {pvc.status}
                              </span>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="text-center py-12">
                          <p className="text-slate-400">
                            {modalSearchQuery ? '검색 결과가 없습니다' : 'PVC가 없습니다'}
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {selectedResourceType === 'nodes' && (
                    <div className="space-y-2">
                      {filteredResources.length > 0 ? (
                        filteredResources.map((node) => (
                          <div key={node.name} className="p-4 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors">
                            <div className="flex items-center justify-between">
                              <div>
                                <h3 className="font-medium text-white">{node.name}</h3>
                                <p className="text-sm text-slate-400 mt-1">
                                  Version: {node.version || 'N/A'} |
                                  Internal IP: {node.internal_ip || 'N/A'}
                                  {node.roles && node.roles.length > 0 && ` | Roles: ${node.roles.join(', ')}`}
                                </p>
                              </div>
                              <span className={`badge ${node.status === 'Ready' ? 'badge-success' : 'badge-error'
                                }`}>
                                {node.status}
                              </span>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="text-center py-12">
                          <p className="text-slate-400">
                            {modalSearchQuery ? '검색 결과가 없습니다' : '노드가 없습니다'}
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </ModalOverlay>
      )}

      {/* 노드 상세 모달 */}
      {selectedNode && (
        <ModalOverlay onClose={handleCloseNodeDetail}>
          <div
            className="bg-slate-800 rounded-lg max-w-6xl w-full h-[85vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 모달 헤더 */}
            <div className="p-6 border-b border-slate-700">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-cyan-500/10">
                    <Server className="w-5 h-5 text-cyan-400" />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-white">{selectedNode.name}</h2>
                    <p className="text-sm text-slate-400">노드 상세 정보</p>
                  </div>
                </div>
                <button
                  onClick={handleCloseNodeDetail}
                  className="p-2 hover:bg-slate-700 rounded-lg transition-colors"
                >
                  <X className="w-5 h-5 text-slate-400" />
                </button>
              </div>
            </div>

            {/* 모달 내용 */}
            <div className="flex-1 overflow-y-auto p-6">
              {isLoadingNodeDetail || isLoadingComponents ? (
                <div className="flex flex-col items-center justify-center h-full min-h-[300px]">
                  <RefreshCw className="w-8 h-8 text-primary-400 animate-spin mb-4" />
                  <p className="text-slate-400">데이터를 불러오는 중...</p>
                </div>
              ) : (
                <div className="space-y-6">
                  {/* 컴포넌트 상태 */}
                  {componentStatuses && componentStatuses.length > 0 && (
                    <div className="card">
                      <h3 className="text-lg font-bold text-white mb-4">Component Status</h3>
                      <div className="overflow-x-auto">
                        <table className="w-full">
                          <thead>
                            <tr className="border-b border-slate-700">
                              <th className="text-left py-2 px-3 text-slate-400 font-medium">NAME</th>
                              <th className="text-left py-2 px-3 text-slate-400 font-medium">STATUS</th>
                              <th className="text-left py-2 px-3 text-slate-400 font-medium">MESSAGE</th>
                              <th className="text-left py-2 px-3 text-slate-400 font-medium">ERROR</th>
                            </tr>
                          </thead>
                          <tbody>
                            {componentStatuses.map((comp: any) => (
                              <tr key={comp.name} className="border-b border-slate-700/50">
                                <td className="py-3 px-3 text-white font-mono text-sm">{comp.name}</td>
                                <td className="py-3 px-3">
                                  <span className={`badge ${comp.status === 'Healthy' ? 'badge-success' :
                                    comp.status === 'Unavailable' ? 'badge-warning' : 'badge-error'
                                    }`}>
                                    {comp.status}
                                  </span>
                                </td>
                                <td className="py-3 px-3 text-slate-300 text-sm">{comp.message || '-'}</td>
                                <td className="py-3 px-3 text-slate-300 text-sm">{comp.error || '-'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Node Describe 정보 */}
                  {nodeDetail && (
                    <>
                      {/* 기본 정보 */}
                      <div className="card">
                        <h3 className="text-lg font-bold text-white mb-4">기본 정보</h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div>
                            <p className="text-sm text-slate-400 mb-1">이름</p>
                            <p className="text-white font-mono">{nodeDetail.name}</p>
                          </div>
                          {nodeDetail.system_info && (
                            <>
                              <div>
                                <p className="text-sm text-slate-400 mb-1">OS Image</p>
                                <p className="text-white">{nodeDetail.system_info.os_image}</p>
                              </div>
                              <div>
                                <p className="text-sm text-slate-400 mb-1">Kernel Version</p>
                                <p className="text-white font-mono">{nodeDetail.system_info.kernel_version}</p>
                              </div>
                              <div>
                                <p className="text-sm text-slate-400 mb-1">Container Runtime</p>
                                <p className="text-white font-mono">{nodeDetail.system_info.container_runtime}</p>
                              </div>
                              <div>
                                <p className="text-sm text-slate-400 mb-1">Kubelet Version</p>
                                <p className="text-white font-mono">{nodeDetail.system_info.kubelet_version}</p>
                              </div>
                              <div>
                                <p className="text-sm text-slate-400 mb-1">Kube-Proxy Version</p>
                                <p className="text-white font-mono">{nodeDetail.system_info.kube_proxy_version}</p>
                              </div>
                            </>
                          )}
                        </div>
                      </div>

                      {/* 주소 */}
                      {nodeDetail.addresses && nodeDetail.addresses.length > 0 && (
                        <div className="card">
                          <h3 className="text-lg font-bold text-white mb-4">Addresses</h3>
                          <div className="space-y-2">
                            {nodeDetail.addresses.map((addr: any, idx: number) => (
                              <div key={idx} className="flex items-center gap-3 p-2 bg-slate-700 rounded">
                                <span className="text-slate-400 text-sm font-medium w-32">{addr.type}</span>
                                <span className="text-white font-mono">{addr.address}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Conditions */}
                      {nodeDetail.conditions && nodeDetail.conditions.length > 0 && (
                        <div className="card">
                          <h3 className="text-lg font-bold text-white mb-4">Conditions</h3>
                          <div className="overflow-x-auto">
                            <table className="w-full">
                              <thead>
                                <tr className="border-b border-slate-700">
                                  <th className="text-left py-2 px-3 text-slate-400 font-medium">Type</th>
                                  <th className="text-left py-2 px-3 text-slate-400 font-medium">Status</th>
                                  <th className="text-left py-2 px-3 text-slate-400 font-medium">Reason</th>
                                  <th className="text-left py-2 px-3 text-slate-400 font-medium">Message</th>
                                </tr>
                              </thead>
                              <tbody>
                                {nodeDetail.conditions.map((condition: any, idx: number) => (
                                  <tr key={idx} className="border-b border-slate-700/50">
                                    <td className="py-3 px-3 text-white font-medium">{condition.type}</td>
                                    <td className="py-3 px-3">
                                      <span className={`badge ${condition.status === 'True' ? 'badge-success' :
                                        condition.status === 'False' ? 'badge-error' : 'badge-warning'
                                        }`}>
                                        {condition.status}
                                      </span>
                                    </td>
                                    <td className="py-3 px-3 text-slate-300 text-sm">{condition.reason || '-'}</td>
                                    <td className="py-3 px-3 text-slate-300 text-sm">{condition.message || '-'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}

                      {/* Labels */}
                      {nodeDetail.labels && Object.keys(nodeDetail.labels).length > 0 && (
                        <div className="card">
                          <h3 className="text-lg font-bold text-white mb-4">Labels</h3>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-64 overflow-y-auto">
                            {Object.entries(nodeDetail.labels).map(([key, value]) => (
                              <div key={key} className="p-2 bg-slate-700 rounded text-xs">
                                <span className="text-slate-400">{key}:</span>{' '}
                                <span className="text-white font-mono">{value as string}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Annotations */}
                      {nodeDetail.annotations && Object.keys(nodeDetail.annotations).length > 0 && (
                        <div className="card">
                          <h3 className="text-lg font-bold text-white mb-4">Annotations</h3>
                          <div className="grid grid-cols-1 gap-2 max-h-64 overflow-y-auto">
                            {Object.entries(nodeDetail.annotations).map(([key, value]) => (
                              <div key={key} className="p-2 bg-slate-700 rounded text-xs">
                                <span className="text-slate-400 break-all">{key}:</span>{' '}
                                <span className="text-white font-mono break-all">{value as string}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </ModalOverlay>
      )}
    </div>
  )
}
