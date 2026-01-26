import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/services/api'
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
  Search
} from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { useState } from 'react'

type ResourceType = 'namespaces' | 'pods' | 'services' | 'deployments' | 'pvcs' | 'nodes'

export default function Dashboard() {
  const queryClient = useQueryClient()
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [selectedResourceType, setSelectedResourceType] = useState<ResourceType | null>(null)
  const [modalSearchQuery, setModalSearchQuery] = useState<string>('')
  
  const { data: overview, isLoading } = useQuery({
    queryKey: ['cluster-overview'],
    queryFn: api.getClusterOverview,
    staleTime: 30000, // 30초 동안 캐시 유지
    refetchInterval: 60000, // 60초마다 갱신
  })

  // 네임스페이스 목록
  const { data: namespaces, isLoading: isLoadingNamespaces } = useQuery({
    queryKey: ['namespaces'],
    queryFn: api.getNamespaces,
    enabled: selectedResourceType === 'namespaces',
  })

  // 전체 Pod 목록
  const { data: allPods, isLoading: isLoadingPods } = useQuery({
    queryKey: ['all-pods'],
    queryFn: api.getAllPods,
    enabled: selectedResourceType === 'pods',
  })

  // 전체 Services 목록 (모든 네임스페이스)
  const { data: allNamespaces, isLoading: isLoadingAllNamespaces } = useQuery({
    queryKey: ['all-namespaces'],
    queryFn: api.getNamespaces,
    enabled: selectedResourceType === 'services' || selectedResourceType === 'deployments',
  })

  const { data: allServices, isLoading: isLoadingServices } = useQuery({
    queryKey: ['all-services'],
    queryFn: async () => {
      if (!allNamespaces) return []
      const services = await Promise.all(
        allNamespaces.map(ns => api.getServices(ns.name))
      )
      return services.flat()
    },
    enabled: selectedResourceType === 'services' && !!allNamespaces,
  })

  // 전체 Deployments 목록
  const { data: allDeployments, isLoading: isLoadingDeployments } = useQuery({
    queryKey: ['all-deployments'],
    queryFn: async () => {
      if (!allNamespaces) return []
      const deployments = await Promise.all(
        allNamespaces.map(ns => api.getDeployments(ns.name))
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
    queryFn: api.getNodes,
    staleTime: 30000,
    refetchInterval: 60000,
  })

  // 노드 목록 (모달용)
  const { data: modalNodes, isLoading: isLoadingNodes } = useQuery({
    queryKey: ['modal-nodes'],
    queryFn: api.getNodes,
    enabled: selectedResourceType === 'nodes',
  })
  
  const handleRefresh = async () => {
    setIsRefreshing(true)
    await queryClient.invalidateQueries({ queryKey: ['cluster-overview'] })
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const handleStatClick = (type: ResourceType) => {
    setSelectedResourceType(type)
  }

  const handleCloseModal = () => {
    setSelectedResourceType(null)
    setModalSearchQuery('')
  }

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
    if (selectedResourceType === 'namespaces') return namespaces?.length || 0
    if (selectedResourceType === 'pods') return allPods?.length || 0
    if (selectedResourceType === 'services') return allServices?.length || 0
    if (selectedResourceType === 'deployments') return allDeployments?.length || 0
    if (selectedResourceType === 'pvcs') return allPVCs?.length || 0
    if (selectedResourceType === 'nodes') return modalNodes?.length || 0
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
    if (!modalSearchQuery.trim()) {
      if (selectedResourceType === 'namespaces') return namespaces || []
      if (selectedResourceType === 'pods') return allPods || []
      if (selectedResourceType === 'services') return allServices || []
      if (selectedResourceType === 'deployments') return allDeployments || []
      if (selectedResourceType === 'pvcs') return allPVCs || []
      if (selectedResourceType === 'nodes') return modalNodes || []
      return []
    }

    const query = modalSearchQuery.toLowerCase()

    if (selectedResourceType === 'namespaces') {
      return (namespaces || []).filter(ns => 
        ns.name.toLowerCase().includes(query)
      )
    }

    if (selectedResourceType === 'pods') {
      return (allPods || []).filter(pod => 
        pod.name.toLowerCase().includes(query) ||
        pod.namespace.toLowerCase().includes(query) ||
        (pod.node_name && pod.node_name.toLowerCase().includes(query))
      )
    }

    if (selectedResourceType === 'services') {
      return (allServices || []).filter(svc => 
        svc.name.toLowerCase().includes(query) ||
        svc.namespace.toLowerCase().includes(query) ||
        (svc.type && svc.type.toLowerCase().includes(query)) ||
        (svc.cluster_ip && svc.cluster_ip.toLowerCase().includes(query))
      )
    }

    if (selectedResourceType === 'deployments') {
      return (allDeployments || []).filter(deploy => 
        deploy.name.toLowerCase().includes(query) ||
        deploy.namespace.toLowerCase().includes(query)
      )
    }

    if (selectedResourceType === 'pvcs') {
      return (allPVCs || []).filter(pvc => 
        pvc.name.toLowerCase().includes(query) ||
        pvc.namespace.toLowerCase().includes(query) ||
        (pvc.storage_class && pvc.storage_class.toLowerCase().includes(query))
      )
    }

    if (selectedResourceType === 'nodes') {
      return (modalNodes || []).filter(node => 
        node.name.toLowerCase().includes(query) ||
        (node.version && node.version.toLowerCase().includes(query)) ||
        (node.internal_ip && node.internal_ip.toLowerCase().includes(query)) ||
        (node.roles && node.roles.some(role => role.toLowerCase().includes(query)))
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
  const nodeStatusData = nodes
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
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={podStatusData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="name" stroke="#94a3b8" />
                <YAxis stroke="#94a3b8" />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: '#1e293b', 
                    border: '1px solid #334155',
                    borderRadius: '8px'
                  }}
                />
                <Bar dataKey="value" fill="#0ea5e9" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Node Status Chart */}
        {nodeStatusChartData.length > 0 && (
          <div className="card">
            <h2 className="text-xl font-bold text-white mb-4">노드 상태</h2>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={nodeStatusChartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="name" stroke="#94a3b8" />
                <YAxis stroke="#94a3b8" />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: '#1e293b', 
                    border: '1px solid #334155',
                    borderRadius: '8px'
                  }}
                />
                <Bar 
                  dataKey="value" 
                  fill="#06b6d4"
                  fillOpacity={0.8}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* 노드 상세 정보 - 별도 카드 */}
      {nodes && nodes.length > 0 && (
        <div className="card">
          <h2 className="text-xl font-bold text-white mb-4">노드 목록</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 max-h-[400px] overflow-y-auto">
            {nodes.map((node) => (
              <div key={node.name} className="p-3 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors">
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
                  <span className={`badge text-xs ${
                    node.status === 'Ready' ? 'badge-success' : 'badge-error'
                  }`}>
                    {node.status}
                  </span>
                </div>
              </div>
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-lg max-w-4xl w-full h-[80vh] overflow-hidden flex flex-col">
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
                        <span className={`badge ${
                          ns.status === 'Active' ? 'badge-success' : 'badge-warning'
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
                          <span className={`badge ${
                            pod.phase === 'Running' ? 'badge-success' : 'badge-warning'
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
                        <span className={`badge ${
                          deploy.ready_replicas === deploy.replicas ? 'badge-success' : 'badge-warning'
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
                        <span className={`badge ${
                          pvc.status === 'Bound' ? 'badge-success' : 'badge-warning'
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
                              <span className={`badge ${
                                node.status === 'Ready' ? 'badge-success' : 'badge-error'
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
        </div>
      )}
    </div>
  )
}
