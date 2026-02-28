import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { api } from '@/services/api'
import { Box, ArrowRight, Network, RefreshCw, Search, Waypoints, X } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { ko, enUS } from 'date-fns/locale'
import { useState, useMemo } from 'react'
import { ModalOverlay } from '@/components/ModalOverlay'
import { useTranslation } from 'react-i18next'

export default function Namespaces() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { t, i18n } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const distanceLocale = i18n.language === 'ko' ? ko : enUS
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedNamespaceForDescribe, setSelectedNamespaceForDescribe] = useState<string | null>(null)
  
  const { data: namespaces, isLoading } = useQuery({
    queryKey: ['namespaces'],
    queryFn: () => api.getNamespaces(false), // 자동 갱신은 캐시 사용
    staleTime: 30000,
  })

  const {
    data: namespaceDescribe,
    isLoading: isLoadingNamespaceDescribe,
    error: namespaceDescribeError,
  } = useQuery({
    queryKey: ['namespace-describe', selectedNamespaceForDescribe],
    queryFn: () => api.describeNamespace(selectedNamespaceForDescribe!),
    enabled: !!selectedNamespaceForDescribe,
  })
  
  // 검색어로 네임스페이스 필터링
  const filteredNamespaces = useMemo(() => {
    if (!namespaces || !Array.isArray(namespaces)) return []
    if (!searchQuery.trim()) return namespaces
    return namespaces.filter(ns => 
      ns.name.toLowerCase().includes(searchQuery.toLowerCase())
    )
  }, [namespaces, searchQuery])
  
  const handleRefresh = async () => {
    setIsRefreshing(true)
    // 새로고침은 항상 강제 갱신
    try {
      // 먼저 네임스페이스 목록을 가져옴
      const namespacesData = await api.getNamespaces(true)
      
      // 모든 리소스를 병렬로 조회
      const [allPodsData, allServicesData, allDeploymentsData, allPVCsData] = await Promise.all([
        api.getAllPods(true),
        Promise.all(namespacesData.map((ns: any) => api.getServices(ns.name, true))).then(results => results.flat()),
        Promise.all(namespacesData.map((ns: any) => api.getDeployments(ns.name, true))).then(results => results.flat()),
        api.getPVCs(undefined, true),
      ])
      
      // 네임스페이스별 실제 리소스 개수 계산
      const podCountsByNs: Record<string, number> = {}
      const serviceCountsByNs: Record<string, number> = {}
      const deploymentCountsByNs: Record<string, number> = {}
      const pvcCountsByNs: Record<string, number> = {}
      
      allPodsData.forEach((pod: any) => {
        podCountsByNs[pod.namespace] = (podCountsByNs[pod.namespace] || 0) + 1
      })
      allServicesData.forEach((svc: any) => {
        serviceCountsByNs[svc.namespace] = (serviceCountsByNs[svc.namespace] || 0) + 1
      })
      allDeploymentsData.forEach((deploy: any) => {
        deploymentCountsByNs[deploy.namespace] = (deploymentCountsByNs[deploy.namespace] || 0) + 1
      })
      allPVCsData.forEach((pvc: any) => {
        pvcCountsByNs[pvc.namespace] = (pvcCountsByNs[pvc.namespace] || 0) + 1
      })
      
      // 네임스페이스 데이터에 실제 리소스 개수로 보정
      const correctedNamespaces = namespacesData.map((ns: any) => ({
        ...ns,
        resource_count: {
          pods: podCountsByNs[ns.name] || 0,
          services: serviceCountsByNs[ns.name] || 0,
          deployments: deploymentCountsByNs[ns.name] || 0,
          pvcs: pvcCountsByNs[ns.name] || 0,
        }
      }))
      
      // 캐시 제거 후 새 데이터로 업데이트
      queryClient.removeQueries({ queryKey: ['namespaces'] })
      queryClient.setQueryData(['namespaces'], correctedNamespaces)
    } catch (error) {
      console.error('새로고침 실패:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[300px]">
        <RefreshCw className="w-8 h-8 text-primary-400 animate-spin mb-4" />
        <p className="text-slate-400">{tr('namespaces.loading', 'Loading data...')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('namespaces.title', 'Namespaces')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('namespaces.subtitle', 'Review all namespaces in the cluster and manage resources')}
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={isRefreshing}
          className="btn btn-secondary flex items-center gap-2"
        >
          <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          {tr('namespaces.refresh', 'Refresh')}
        </button>
      </div>

      {/* 검색창 */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-slate-400" />
        <input
          type="text"
          placeholder={tr('namespaces.searchPlaceholder', 'Search namespaces...')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-10 pr-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
        />
      </div>

      {/* 검색 결과 개수 표시 */}
      {searchQuery && (
        <p className="text-sm text-slate-400">
          {tr('namespaces.matchCount', '{{count}} namespaces found', { count: filteredNamespaces.length })}
        </p>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {filteredNamespaces.length > 0 ? (
          filteredNamespaces.map((ns) => (
          <div
            key={ns.name}
            className="card hover:border-primary-500 transition-colors cursor-pointer"
            onClick={() => setSelectedNamespaceForDescribe(ns.name)}
          >
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="p-3 bg-primary-500/10 rounded-lg">
                  <Box className="w-6 h-6 text-primary-400" />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-white">{ns.name}</h3>
                  <p className="text-sm text-slate-400">
                    {tr('namespaces.created', 'Created')}: {formatDistanceToNow(new Date(ns.created_at), { 
                      addSuffix: true, 
                      locale: distanceLocale 
                    })}
                  </p>
                </div>
              </div>
              <span className={`badge ${
                ns.status === 'Active' ? 'badge-success' : 'badge-warning'
              }`}>
                {ns.status}
              </span>
            </div>

            <div className="mt-6 grid grid-cols-4 gap-4">
              <div>
                <p className="text-sm text-slate-400">{tr('namespaces.metrics.pods', 'Pods')}</p>
                <p className="text-2xl font-bold text-white">
                  {ns.resource_count?.pods || 0}
                </p>
              </div>
              <div>
                <p className="text-sm text-slate-400">{tr('namespaces.metrics.services', 'Services')}</p>
                <p className="text-2xl font-bold text-white">
                  {ns.resource_count?.services || 0}
                </p>
              </div>
              <div>
                <p className="text-sm text-slate-400">{tr('namespaces.metrics.deployments', 'Deployments')}</p>
                <p className="text-2xl font-bold text-white">
                  {ns.resource_count?.deployments || 0}
                </p>
              </div>
              <div>
                <p className="text-sm text-slate-400">{tr('namespaces.metrics.pvcs', 'PVCs')}</p>
                <p className="text-2xl font-bold text-white">
                  {ns.resource_count?.pvcs || 0}
                </p>
              </div>
            </div>

            <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-3">
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  navigate(`/resources/${ns.name}`)
                }}
                className="btn btn-primary flex items-center justify-center gap-2"
              >
                {tr('namespaces.actions.resources', 'View resources')}
                <ArrowRight className="w-4 h-4" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  navigate(`/network/${ns.name}`)
                }}
                className="btn btn-secondary flex items-center justify-center gap-2"
              >
                <Waypoints className="w-4 h-4" />
                {tr('namespaces.actions.network', 'View network')}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  navigate(`/topology/${ns.name}`)
                }}
                className="btn btn-secondary flex items-center justify-center gap-2"
              >
                <Network className="w-4 h-4" />
                {tr('namespaces.actions.yaml', 'View YAML')}
              </button>
            </div>
          </div>
          ))
        ) : (
          <div className="col-span-full text-center py-12">
            <p className="text-slate-400">
              {searchQuery
                ? tr('namespaces.noSearchResults', 'No results found')
                : tr('namespaces.empty', 'No namespaces found')}
            </p>
          </div>
        )}
      </div>

      {selectedNamespaceForDescribe && (
        <ModalOverlay onClose={() => setSelectedNamespaceForDescribe(null)}>
          <div
            className="bg-slate-900 border border-slate-700 rounded-xl max-w-3xl w-full max-h-[80vh] overflow-hidden shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
              <div>
                <h2 className="text-lg font-semibold text-white">
                  {tr('namespaces.describe.title', 'Namespace details')}: {selectedNamespaceForDescribe}
                </h2>
                <p className="text-xs text-slate-400">
                  {tr('namespaces.describe.subtitle', 'Details from kubectl describe namespace {{name}}', {
                    name: selectedNamespaceForDescribe,
                  })}
                </p>
              </div>
              <button
                onClick={() => setSelectedNamespaceForDescribe(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 max-h-[60vh] overflow-y-auto text-sm space-y-4">
              {isLoadingNamespaceDescribe ? (
                <p className="text-slate-400">{tr('namespaces.describe.loading', 'Loading namespace details...')}</p>
              ) : namespaceDescribeError ? (
                <p className="text-red-400">{tr('namespaces.describe.error', 'Failed to load namespace details.')}</p>
              ) : namespaceDescribe ? (
                <>
                  <div>
                    <p className="text-xs text-slate-400 mb-1">{tr('namespaces.describe.basicInfo', 'Basic information')}</p>
                    <pre className="bg-slate-800 rounded-md p-2 text-xs whitespace-pre-wrap text-slate-200">
{`${tr('namespaces.describe.name', 'Name')}: ${namespaceDescribe.name}
${tr('namespaces.describe.status', 'Status')}: ${namespaceDescribe.status || tr('common.notAvailable', 'N/A')}
${tr('namespaces.describe.createdAt', 'Created at')}: ${namespaceDescribe.created_at || tr('common.notAvailable', 'N/A')}`}
                    </pre>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs text-slate-400 mb-1">{tr('namespaces.describe.labels', 'Labels')}</p>
                      <pre className="bg-slate-800 rounded-md p-2 text-xs whitespace-pre-wrap text-slate-200">
                        {namespaceDescribe.labels &&
                        Object.keys(namespaceDescribe.labels).length > 0
                          ? Object.entries(namespaceDescribe.labels)
                              .map(([k, v]) => `${k}=${v}`)
                              .join('\n')
                          : tr('common.none', '(none)')}
                      </pre>
                    </div>
                    <div>
                      <p className="text-xs text-slate-400 mb-1">{tr('namespaces.describe.annotations', 'Annotations')}</p>
                      <pre className="bg-slate-800 rounded-md p-2 text-xs whitespace-pre-wrap text-slate-200">
                        {namespaceDescribe.annotations &&
                        Object.keys(namespaceDescribe.annotations).length > 0
                          ? Object.entries(namespaceDescribe.annotations)
                              .map(([k, v]) => `${k}=${v}`)
                              .join('\n')
                          : tr('common.none', '(none)')}
                      </pre>
                    </div>
                  </div>
                  {namespaceDescribe.events && namespaceDescribe.events.length > 0 && (
                    <div>
                      <p className="text-xs text-slate-400 mb-1">{tr('namespaces.describe.recentEvents', 'Recent events')}</p>
                      <pre className="bg-slate-800 rounded-md p-2 text-xs whitespace-pre-wrap text-slate-200">
                        {namespaceDescribe.events
                          .map(
                            (e) =>
                              `[${e.type || ''}] ${e.reason || ''}: ${
                                e.message || ''
                              } (count=${e.count ?? 1})`
                          )
                          .join('\n')}
                      </pre>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-slate-400">{tr('namespaces.describe.notFound', 'Namespace details not found.')}</p>
              )}
            </div>
          </div>
        </ModalOverlay>
      )}
    </div>
  )
}
