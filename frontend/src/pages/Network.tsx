import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, type NetworkPolicyInfo, type PodInfo, type ServiceInfo } from '@/services/api'
import { Network, Search, Server, Shield, Waypoints } from 'lucide-react'

function buildLabelSelector(selector: Record<string, string> | undefined | null): string | undefined {
  if (!selector) return undefined
  const entries = Object.entries(selector).filter(([k, v]) => k && v)
  if (entries.length === 0) return undefined
  return entries.map(([k, v]) => `${k}=${v}`).join(',')
}

function podMatchesNetworkPolicy(pod: PodInfo, policy: NetworkPolicyInfo): boolean {
  const labels = pod.labels || {}
  const sel = policy.pod_selector || { match_labels: {}, match_expressions: [] }

  const matchLabels = sel.match_labels || {}
  for (const [k, v] of Object.entries(matchLabels)) {
    if (labels[k] !== v) return false
  }

  for (const expr of sel.match_expressions || []) {
    const key = expr.key ?? ''
    const op = (expr.operator ?? '').toLowerCase()
    const values = expr.values ?? []
    const hasKey = Object.prototype.hasOwnProperty.call(labels, key)
    const value = labels[key]

    if (op === 'in') {
      if (!hasKey) return false
      if (!values.includes(value)) return false
      continue
    }
    if (op === 'notin') {
      if (!hasKey) continue
      if (values.includes(value)) return false
      continue
    }
    if (op === 'exists') {
      if (!hasKey) return false
      continue
    }
    if (op === 'doesnotexist') {
      if (hasKey) return false
      continue
    }

    // Unknown operator -> be safe and mark as non-match
    return false
  }

  return true
}

export default function NetworkPage() {
  const { namespace } = useParams<{ namespace: string }>()
  const [selectedServiceName, setSelectedServiceName] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  const { data: services, isLoading: isLoadingServices } = useQuery({
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
    queryFn: api.getIngressClasses,
  })

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

  const filteredServices = useMemo(() => {
    const list = services ?? []
    if (!searchQuery.trim()) return list
    const q = searchQuery.toLowerCase()
    return list.filter((s) => s.name.toLowerCase().includes(q))
  }, [services, searchQuery])

  const related = useMemo(() => {
    if (!selectedService) {
      return {
        endpoints: null,
        endpointSlices: [],
        ingresses: [],
        networkPolicies: [],
      }
    }

    const endpoint = (endpoints ?? []).find((e) => e.name === selectedService.name) ?? null
    const slices = (endpointSlices ?? []).filter((s) => s.service_name === selectedService.name)
    const ingressList = (ingresses ?? []).filter((ing) => (ing.backends ?? []).includes(selectedService.name))

    const pods = podsForService ?? []
    const policies = (networkPolicies ?? []).filter((p) => {
      if (pods.length === 0) return false
      // Empty selector means "all pods"
      const sel = p.pod_selector
      const hasAnyConstraint =
        (sel?.match_labels && Object.keys(sel.match_labels).length > 0) ||
        (sel?.match_expressions && sel.match_expressions.length > 0)
      if (!hasAnyConstraint) return true
      return pods.some((pod) => podMatchesNetworkPolicy(pod, p))
    })

    return {
      endpoints: endpoint,
      endpointSlices: slices,
      ingresses: ingressList,
      networkPolicies: policies,
    }
  }, [selectedService, endpoints, endpointSlices, ingresses, networkPolicies, podsForService])

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
        <div className="text-right text-xs text-slate-400">
          <div>Services: {services?.length ?? 0}</div>
          <div>Ingresses: {ingresses?.length ?? 0}</div>
          <div>Endpoints: {endpoints?.length ?? 0}</div>
          <div>EndpointSlices: {endpointSlices?.length ?? 0}</div>
          <div>NetworkPolicies: {networkPolicies?.length ?? 0}</div>
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

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="bg-slate-800/60 rounded-lg border border-slate-700 p-4">
                  <div className="text-sm font-semibold text-white mb-2">Ports</div>
                  <div className="space-y-2 text-sm text-slate-200">
                    {(selectedService.ports || []).length === 0 ? (
                      <div className="text-slate-400">(없음)</div>
                    ) : (
                      selectedService.ports.map((p, idx) => (
                        <div key={idx} className="flex items-center justify-between gap-3">
                          <div className="truncate">
                            <span className="text-slate-300">{p.protocol}</span> {p.port} →{' '}
                            <span className="text-slate-300">{p.target_port}</span>
                          </div>
                          <div className="text-xs text-slate-400">{p.name || ''}</div>
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
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="bg-slate-800/60 rounded-lg border border-slate-700 p-4">
                  <div className="text-sm font-semibold text-white mb-2">Endpoints</div>
                  {related.endpoints ? (
                    <div className="space-y-3">
                      <div className="flex items-center gap-3 text-sm">
                        <span className="badge badge-success">ready {related.endpoints.ready_count}</span>
                        <span className="badge badge-warning">not ready {related.endpoints.not_ready_count}</span>
                      </div>
                      <div className="text-xs text-slate-400">Ready addresses (max 50)</div>
                      <pre className="text-xs text-slate-200 whitespace-pre-wrap break-words bg-slate-900/40 border border-slate-700 rounded-md p-2 max-h-32 overflow-y-auto">
                        {(related.endpoints.ready_addresses || []).join('\n') || '(없음)'}
                      </pre>
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
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="bg-slate-800/60 rounded-lg border border-slate-700 p-4">
                  <div className="text-sm font-semibold text-white mb-2">Ingress</div>
                  {related.ingresses.length === 0 ? (
                    <div className="text-sm text-slate-400">(없음)</div>
                  ) : (
                    <div className="space-y-3">
                      {related.ingresses.map((ing) => {
                        const klass = (ingressClasses ?? []).find((c) => c.name === (ing.class ?? '')) ?? null
                        return (
                          <div key={ing.name} className="rounded-md border border-slate-700 bg-slate-900/30 p-3">
                            <div className="flex items-center justify-between gap-3">
                              <div className="font-medium text-slate-100 truncate">{ing.name}</div>
                              <div className="text-xs text-slate-400">
                                class: {ing.class || '(none)'}
                                {klass?.is_default ? ' (default)' : ''}
                              </div>
                            </div>
                            <div className="mt-1 text-xs text-slate-300 whitespace-pre-wrap break-words">
                              {(ing.hosts || []).join('\n') || '(hosts 없음)'}
                            </div>
                            {klass?.controller ? (
                              <div className="mt-2 text-[11px] text-slate-400">controller: {klass.controller}</div>
                            ) : null}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>

                <div className="bg-slate-800/60 rounded-lg border border-slate-700 p-4">
                  <div className="text-sm font-semibold text-white mb-2 flex items-center gap-2">
                    <Shield className="w-4 h-4" />
                    NetworkPolicies (적용 후보)
                  </div>
                  {!labelSelector ? (
                    <div className="text-sm text-slate-400">selector가 없어 Pod 매핑을 못해 정책 연결을 계산할 수 없습니다</div>
                  ) : (podsForService ?? []).length === 0 ? (
                    <div className="text-sm text-slate-400">선택된 Service selector에 매칭되는 Pod가 없습니다</div>
                  ) : related.networkPolicies.length === 0 ? (
                    <div className="text-sm text-slate-400">(없음)</div>
                  ) : (
                    <div className="space-y-3">
                      {related.networkPolicies.map((p) => (
                        <div key={p.name} className="rounded-md border border-slate-700 bg-slate-900/30 p-3">
                          <div className="flex items-center justify-between gap-3">
                            <div className="font-medium text-slate-100 truncate">{p.name}</div>
                            <div className="text-xs text-slate-400">{(p.policy_types || []).join(', ') || ''}</div>
                          </div>
                          <div className="mt-1 text-xs text-slate-300">
                            ingress rules: {p.ingress_rules} · egress rules: {p.egress_rules}
                          </div>
                          <div className="mt-2 text-[11px] text-slate-400">
                            selector:{' '}
                            {Object.keys(p.pod_selector?.match_labels || {}).length > 0
                              ? Object.entries(p.pod_selector.match_labels)
                                  .map(([k, v]) => `${k}=${v}`)
                                  .join(', ')
                              : '(all pods)'}
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
      </div>
    </div>
  )
}

