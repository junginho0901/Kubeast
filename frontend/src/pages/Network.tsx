import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type ServiceInfo } from '@/services/api'
import { useAIContext } from '@/hooks/useAIContext'
import { AlertTriangle, Network, RefreshCw, Search, Server, Waypoints } from 'lucide-react'
import { buildLabelSelector } from './network-overview/netHelpers'
import { EndpointTargets } from './network-overview/EndpointTargets'
import { useNetworkAnalysis } from './network-overview/useNetworkAnalysis'
import { IngressSection } from './network-overview/IngressSection'
import { NetworkPoliciesSection } from './network-overview/NetworkPoliciesSection'

export default function NetworkPage() {
  const { namespace } = useParams<{ namespace: string }>()
  const queryClient = useQueryClient()
  const [selectedServiceName, setSelectedServiceName] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)

  const {
    data: services,
    isLoading: isLoadingServices,
  } = useQuery({
    queryKey: ['network', 'services', namespace],
    queryFn: () => api.getServices(namespace!),
    enabled: !!namespace,
  })

  const { data: ingresses } = useQuery({
    queryKey: ['network', 'ingresses', namespace],
    queryFn: () => api.getIngresses(namespace!),
    enabled: !!namespace,
  })

  const { data: endpoints } = useQuery({
    queryKey: ['network', 'endpoints', namespace],
    queryFn: () => api.getEndpoints(namespace!),
    enabled: !!namespace,
  })

  const { data: endpointSlices } = useQuery({
    queryKey: ['network', 'endpointslices', namespace],
    queryFn: () => api.getEndpointSlices(namespace!),
    enabled: !!namespace,
  })

  const { data: networkPolicies } = useQuery({
    queryKey: ['network', 'networkpolicies', namespace],
    queryFn: () => api.getNetworkPolicies(namespace!),
    enabled: !!namespace,
  })

  const { data: ingressClasses } = useQuery({
    queryKey: ['network', 'ingressclasses'],
    queryFn: () => api.getIngressClasses(),
  })

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!namespace) return null
    const svcCount = services?.length ?? 0
    const ingCount = ingresses?.length ?? 0
    const epCount = endpoints?.length ?? 0
    const epsCount = endpointSlices?.length ?? 0
    const npCount = networkPolicies?.length ?? 0
    return {
      source: 'base' as const,
      summary: `네트워크 · ${namespace} · Service ${svcCount}, Ingress ${ingCount}, Endpoints ${epCount}, NetworkPolicy ${npCount}`,
      data: {
        namespace,
        filters: { search: searchQuery || undefined, selected_service: selectedServiceName || undefined },
        stats: {
          services: svcCount,
          ingresses: ingCount,
          endpoints: epCount,
          endpoint_slices: epsCount,
          network_policies: npCount,
          ingress_classes: ingressClasses?.length ?? 0,
        },
      },
    }
  }, [namespace, services, ingresses, endpoints, endpointSlices, networkPolicies, ingressClasses, searchQuery, selectedServiceName])

  useAIContext(aiSnapshot, [aiSnapshot])

  const selectedService: ServiceInfo | null = useMemo(() => {
    if (!services || !selectedServiceName) return null
    return services.find((s) => s.name === selectedServiceName) ?? null
  }, [services, selectedServiceName])

  const labelSelector = useMemo(() => buildLabelSelector(selectedService?.selector), [selectedService?.selector])

  const { data: podsForService } = useQuery({
    queryKey: ['network', 'pods', namespace, selectedService?.name, labelSelector],
    queryFn: () => api.getPods(namespace!, labelSelector),
    enabled: !!namespace && !!selectedService && !!labelSelector,
  })

  const handleRefresh = async () => {
    if (!namespace) return
    setIsRefreshing(true)
    try {
      const [
        freshServices,
        freshIngresses,
        freshEndpoints,
        freshEndpointSlices,
        freshNetworkPolicies,
        freshIngressClasses,
        freshPodsForService,
      ] = await Promise.all([
        api.getServices(namespace, true),
        api.getIngresses(namespace, true),
        api.getEndpoints(namespace, true),
        api.getEndpointSlices(namespace, true),
        api.getNetworkPolicies(namespace, true),
        api.getIngressClasses(true),
        selectedService && labelSelector ? api.getPods(namespace, labelSelector, true) : Promise.resolve(null),
      ])

      queryClient.setQueryData(['network', 'services', namespace], freshServices)
      queryClient.setQueryData(['network', 'ingresses', namespace], freshIngresses)
      queryClient.setQueryData(['network', 'endpoints', namespace], freshEndpoints)
      queryClient.setQueryData(['network', 'endpointslices', namespace], freshEndpointSlices)
      queryClient.setQueryData(['network', 'networkpolicies', namespace], freshNetworkPolicies)
      queryClient.setQueryData(['network', 'ingressclasses'], freshIngressClasses)
      if (freshPodsForService && selectedService && labelSelector) {
        queryClient.setQueryData(['network', 'pods', namespace, selectedService.name, labelSelector], freshPodsForService)
      }
    } catch (error) {
      console.error('네트워크 새로고침 실패:', error)
    } finally {
      setTimeout(() => setIsRefreshing(false), 500)
    }
  }

  const filteredServices = useMemo(() => {
    const list = services ?? []
    if (!searchQuery.trim()) return list
    const q = searchQuery.toLowerCase()
    return list.filter((s) => s.name.toLowerCase().includes(q))
  }, [services, searchQuery])

  const { related, heuristics, policySummary, ingressDetails } = useNetworkAnalysis({
    namespace,
    selectedService,
    endpoints,
    endpointSlices,
    ingresses,
    networkPolicies,
    podsForService,
  })

  if (!namespace) {
    return (
      <div className="text-center py-12">
        <Network className="w-16 h-16 text-slate-600 mx-auto mb-4" />
        <p className="text-slate-400">네임스페이스를 선택하세요</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 h-full">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-white flex items-center gap-3">
            <Waypoints className="w-8 h-8" />
            {namespace} Network
          </h1>
          <p className="mt-2 text-slate-400">
            Service ↔ Endpoints/EndpointSlices ↔ Ingress ↔ NetworkPolicy 연결을 빠르게 확인합니다
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title="새로고침 (강제 갱신)"
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            새로고침
          </button>
          <div className="text-right text-xs text-slate-400">
            <div>Services: {services?.length ?? 0}</div>
            <div>Ingresses: {ingresses?.length ?? 0}</div>
            <div>Endpoints: {endpoints?.length ?? 0}</div>
            <div>EndpointSlices: {endpointSlices?.length ?? 0}</div>
            <div>NetworkPolicies: {networkPolicies?.length ?? 0}</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 h-[calc(100vh-220px)]">
        {/* Services list */}
        <div className="card lg:col-span-4 h-full flex flex-col overflow-hidden">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 className="text-lg font-semibold text-white flex items-center gap-2">
              <Server className="w-5 h-5" />
              Services
            </h2>
            <span className="text-xs text-slate-400">{filteredServices.length}</span>
          </div>

          <div className="relative mb-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Service 이름 검색..."
              className="w-full pl-9 pr-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-sm"
            />
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto space-y-2">
            {isLoadingServices ? (
              <p className="text-sm text-slate-400">불러오는 중...</p>
            ) : filteredServices.length === 0 ? (
              <p className="text-sm text-slate-400">Service가 없습니다</p>
            ) : (
              filteredServices.map((svc) => {
                const isActive = svc.name === selectedServiceName
                return (
                  <button
                    key={svc.name}
                    onClick={() => setSelectedServiceName(svc.name)}
                    className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${
                      isActive ? 'bg-primary-600 text-white' : 'bg-slate-800 hover:bg-slate-700 text-slate-200'
                    }`}
                    title={svc.name}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-medium truncate">{svc.name}</div>
                      <div className="text-[11px] opacity-90">{svc.type}</div>
                    </div>
                    <div className="mt-1 text-[11px] text-slate-300/80 truncate">
                      {Object.keys(svc.selector || {}).length > 0 ? (
                        <>selector: {buildLabelSelector(svc.selector)}</>
                      ) : (
                        <>selector: (없음)</>
                      )}
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </div>

        {/* Details */}
        <div className="card lg:col-span-8 h-full overflow-hidden flex flex-col">
          {!selectedService ? (
            <div className="flex-1 flex items-center justify-center text-slate-400">
              왼쪽에서 Service를 선택하세요
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto space-y-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-bold text-white">{selectedService.name}</h2>
                  <div className="mt-1 text-sm text-slate-400">
                    {selectedService.type}
                    {selectedService.cluster_ip ? <> · ClusterIP: {selectedService.cluster_ip}</> : null}
                    {selectedService.external_ip ? <> · External: {selectedService.external_ip}</> : null}
                  </div>
                </div>
                <div className="text-right text-xs text-slate-400">
                  <div>Ports: {selectedService.ports?.length ?? 0}</div>
                  <div>Pods: {podsForService?.length ?? (labelSelector ? 0 : '-')}</div>
                </div>
              </div>

              {heuristics.length > 0 ? (
                <div className="rounded-lg border border-amber-700/60 bg-amber-950/10 p-4">
                  <div className="flex items-center gap-2 text-amber-200 font-semibold">
                    <AlertTriangle className="w-4 h-4" />
                    이상 징후 감지 ({heuristics.length})
                  </div>
                  <div className="mt-3 space-y-2">
                    {heuristics.map((w, idx) => (
                      <div key={idx} className="rounded-md border border-slate-700 bg-slate-900/20 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="text-sm text-slate-100">{w.title}</div>
                          <span className={`badge ${w.level === 'error' ? 'badge-error' : 'badge-warning'}`}>
                            {w.level === 'error' ? 'error' : 'warn'}
                          </span>
                        </div>
                        {w.detail ? <div className="mt-1 text-xs text-slate-400">{w.detail}</div> : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="space-y-4">
                <div className="bg-slate-800/60 rounded-lg border border-slate-700 p-4">
                  <div className="text-sm font-semibold text-white mb-2">Ports</div>
                  <div className="space-y-2 text-sm text-slate-200">
                    {(selectedService.ports || []).length === 0 ? (
                      <div className="text-slate-400">(없음)</div>
                    ) : (
                      selectedService.ports.map((p, idx) => (
                        <div key={idx} className="flex items-center justify-between gap-3">
                          <div className="min-w-0 flex items-center gap-2">
                            <div className="min-w-0 truncate">
                              <span className="text-slate-300">{p.protocol}</span> {p.port} →{' '}
                              <span className="text-slate-300">{p.target_port}</span>
                            </div>
                            {(selectedService.type === 'NodePort' || selectedService.type === 'LoadBalancer') &&
                            typeof p.node_port === 'number' ? (
                              <span className="flex-shrink-0 text-slate-300">{`nodePort ${p.node_port}`}</span>
                            ) : null}
                          </div>
                          <div className="max-w-40 truncate text-xs text-slate-400">{p.name || ''}</div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="bg-slate-800/60 rounded-lg border border-slate-700 p-4">
                  <div className="text-sm font-semibold text-white mb-2">Selector</div>
                  {labelSelector ? (
                    <pre className="text-xs text-slate-200 whitespace-pre-wrap break-words bg-slate-900/40 border border-slate-700 rounded-md p-2">
                      {labelSelector}
                    </pre>
                  ) : (
                    <div className="text-sm text-slate-400">
                      selector가 없는 Service입니다. (Pod 매핑/NetworkPolicy 매핑은 제한됩니다)
                    </div>
                  )}
                </div>

                <div className="bg-slate-800/60 rounded-lg border border-slate-700 p-4">
                  <div className="text-sm font-semibold text-white mb-2">Endpoints</div>
                  {related.endpoints ? (
                    <div className="space-y-3">
                      <div className="flex items-center gap-3 text-sm">
                        <span className="badge badge-success">ready {related.endpoints.ready_count}</span>
                        <span className="badge badge-warning">not ready {related.endpoints.not_ready_count}</span>
                      </div>
                      <div className="bg-slate-900/40 border border-slate-700 rounded-md p-2 max-h-44 overflow-y-auto">
                        <EndpointTargets endpoint={related.endpoints} />
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm text-slate-400">해당 Service 이름의 Endpoints를 찾지 못했습니다</div>
                  )}
                </div>

                <div className="bg-slate-800/60 rounded-lg border border-slate-700 p-4">
                  <div className="text-sm font-semibold text-white mb-2">EndpointSlices</div>
                  {related.endpointSlices.length === 0 ? (
                    <div className="text-sm text-slate-400">(없음)</div>
                  ) : (
                    <div className="space-y-3">
                      {related.endpointSlices.map((s) => (
                        <div key={s.name} className="rounded-md border border-slate-700 bg-slate-900/30 p-3">
                          <div className="flex items-center justify-between gap-3">
                            <div className="font-medium text-slate-100 truncate">{s.name}</div>
                            <div className="text-xs text-slate-400">{s.address_type}</div>
                          </div>
                          <div className="mt-1 text-sm text-slate-300">
                            ready {s.endpoints_ready} / total {s.endpoints_total}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <IngressSection
                  ingresses={related.ingresses}
                  ingressDetails={ingressDetails}
                  ingressClasses={ingressClasses}
                />

                <NetworkPoliciesSection
                  labelSelector={labelSelector}
                  podsForService={podsForService}
                  networkPolicies={related.networkPolicies}
                  policySummary={policySummary}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
