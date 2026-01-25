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
  XCircle
} from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { useState } from 'react'

type ResourceType = 'namespaces' | 'pods' | 'services' | 'deployments' | 'pvcs' | 'nodes'

export default function Dashboard() {
  const queryClient = useQueryClient()
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [selectedResourceType, setSelectedResourceType] = useState<ResourceType | null>(null)
  
  const { data: overview, isLoading } = useQuery({
    queryKey: ['cluster-overview'],
    queryFn: api.getClusterOverview,
    staleTime: 30000, // 30초 동안 캐시 유지
    refetchInterval: 60000, // 60초마다 갱신
  })

  // 네임스페이스 목록
  const { data: namespaces } = useQuery({
    queryKey: ['namespaces'],
    queryFn: api.getNamespaces,
    enabled: selectedResourceType === 'namespaces',
  })

  // 전체 Pod 목록
  const { data: allPods } = useQuery({
    queryKey: ['all-pods'],
    queryFn: api.getAllPods,
    enabled: selectedResourceType === 'pods',
  })

  // 전체 Services 목록 (모든 네임스페이스)
  const { data: allNamespaces } = useQuery({
    queryKey: ['all-namespaces'],
    queryFn: api.getNamespaces,
    enabled: selectedResourceType === 'services' || selectedResourceType === 'deployments',
  })

  const { data: allServices } = useQuery({
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
  const { data: allDeployments } = useQuery({
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
  const { data: allPVCs } = useQuery({
    queryKey: ['all-pvcs'],
    queryFn: () => api.getPVCs(),
    enabled: selectedResourceType === 'pvcs',
  })

  // 노드 목록
  const { data: nodes } = useQuery({
    queryKey: ['nodes'],
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
    if (selectedResourceType === 'nodes') return nodes?.length || 0
    return 0
  }

  if (isLoading) {
    return (
      <div className="space-y-8 animate-pulse">
        <div>
          <div className="h-10 bg-slate-700 rounded w-64 mb-2"></div>
          <div className="h-4 bg-slate-700 rounded w-96"></div>
        </div>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="card">
              <div className="h-20 bg-slate-700 rounded"></div>
            </div>
          ))}
        </div>
        <div className="card">
          <div className="h-80 bg-slate-700 rounded"></div>
        </div>
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
                <div className="p-6 border-b border-slate-700 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {selectedStat && (
                      <div className={`p-2 rounded-lg ${selectedStat.bgColor}`}>
                        <Icon className={`w-5 h-5 ${selectedStat.color}`} />
                      </div>
                    )}
                    <div>
                      <h2 className="text-xl font-bold text-white">
                        {selectedStat?.name || selectedResourceType}
                      </h2>
                      <p className="text-sm text-slate-400">
                        총 {getResourceCount()}개
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
              )
            })()}

            {/* 모달 내용 */}
            <div className="flex-1 overflow-y-auto p-6">
              {selectedResourceType === 'namespaces' && (
                <div className="space-y-2">
                  {namespaces?.map((ns) => (
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
                  ))}
                </div>
              )}

              {selectedResourceType === 'pods' && (
                <div className="space-y-2">
                  {allPods?.map((pod) => (
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
                  ))}
                </div>
              )}

              {selectedResourceType === 'services' && (
                <div className="space-y-2">
                  {allServices?.map((svc) => (
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
                  ))}
                </div>
              )}

              {selectedResourceType === 'deployments' && (
                <div className="space-y-2">
                  {allDeployments?.map((deploy) => (
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
                  ))}
                </div>
              )}

              {selectedResourceType === 'pvcs' && (
                <div className="space-y-2">
                  {allPVCs?.map((pvc) => (
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
                  ))}
                </div>
              )}

              {selectedResourceType === 'nodes' && (
                <div className="space-y-2">
                  {nodes?.map((node) => (
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
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
