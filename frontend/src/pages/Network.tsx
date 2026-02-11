import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type EndpointInfo, type IngressDetail, type NetworkPolicyInfo, type PodInfo, type ServiceInfo } from '@/services/api'
import { AlertTriangle, Network, RefreshCw, Search, Server, Shield, Waypoints } from 'lucide-react'

function buildLabelSelector(selector: Record<string, string> | undefined | null): string | undefined {
  if (!selector) return undefined
  const entries = Object.entries(selector).filter(([k, v]) => k && v)
  if (entries.length === 0) return undefined
  return entries.map(([k, v]) => `${k}=${v}`).join(',')
}

function isNumeric(value: string): boolean {
  return /^[0-9]+$/.test(value)
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

function selectorToInline(
  selector:
    | {
        match_labels: Record<string, string>
        match_expressions?: Array<{
          key?: string | null
          operator?: string | null
          values?: string[] | null
        }>
      }
    | undefined
    | null,
  emptyMeaning: string
): string {
  const labels = selector?.match_labels || {}
  const expressions = selector?.match_expressions || []

  const labelEntries = Object.entries(labels)
  const expressionEntries = expressions
    .map((e) => {
      const key = e.key ?? ''
      const op = e.operator ?? ''
      const values = Array.isArray(e.values) ? e.values.join(',') : ''
      if (!key && !op) return null
      if (values) return `${key} ${op} (${values})`
      return `${key} ${op}`.trim()
    })
    .filter(Boolean) as string[]

  if (labelEntries.length === 0 && expressionEntries.length === 0) return emptyMeaning

  const parts: string[] = []
  if (labelEntries.length > 0) parts.push(labelEntries.map(([k, v]) => `${k}=${v}`).join(', '))
  if (expressionEntries.length > 0) parts.push(expressionEntries.join(', '))
  return parts.join(' · ')
}

function formatPeer(peer: any): string {
  if (!peer) return '(unknown)'
  if (peer.ip_block?.cidr) {
    const except = Array.isArray(peer.ip_block.except) && peer.ip_block.except.length > 0 ? ` except=${peer.ip_block.except.join(',')}` : ''
    return `ipBlock ${peer.ip_block.cidr}${except}`
  }
  const ns = peer.namespace_selector ? selectorToInline(peer.namespace_selector, 'all namespaces') : null
  const pod = peer.pod_selector ? selectorToInline(peer.pod_selector, 'all pods') : null
  if (ns && pod) return `nsSel(${ns}) podSel(${pod})`
  if (ns) return `nsSel(${ns})`
  if (pod) return `podSel(${pod})`
  return '(all)'
}

function formatPorts(ports: any[] | undefined): string {
  if (!Array.isArray(ports) || ports.length === 0) return '(all ports)'
  return ports
    .map((p) => {
      const proto = p.protocol || 'TCP'
      const port = p.port || '*'
      const end = p.end_port ? `-${p.end_port}` : ''
      return `${proto} ${port}${end}`
    })
    .join(', ')
}

function renderEndpointTargets(endpoint: EndpointInfo | null): React.ReactNode {
  if (!endpoint) return '(없음)'

  const renderList = (
    title: string,
    targets: EndpointInfo['ready_targets'] | undefined,
    addresses: string[] | undefined,
    tone: 'success' | 'warning'
  ) => {
    const list = Array.isArray(targets) ? targets : []
    const ips = addresses || []
    const border =
      tone === 'success' ? 'border-emerald-800/60' : 'border-amber-800/60'
    const bg =
      tone === 'success' ? 'bg-emerald-950/20' : 'bg-amber-950/20'
    const label =
      tone === 'success' ? 'text-emerald-300' : 'text-amber-300'

    if (list.length === 0) {
      if (ips.length === 0) {
        return (
          <div className="text-xs text-slate-400">
            {title}: (없음)
          </div>
        )
      }
      return (
        <div>
          <div className={`text-xs ${label}`}>{title}</div>
          <pre className="mt-1 text-xs text-slate-200 whitespace-pre-wrap break-words bg-slate-900/30 border border-slate-700 rounded-md p-2 max-h-44 overflow-y-auto font-mono">
            {ips.join('\n')}
          </pre>
        </div>
      )
    }

    return (
      <div>
        <div className={`text-xs ${label}`}>{title}</div>
        <div className="mt-2 space-y-2">
          {list.map((t, idx) => {
            const ip = t.ip ?? ''
            const ref = t.target_ref
            const refName = ref?.name ? `${ref.kind || 'Target'}:${ref.name}` : null
            const nodeName = t.node_name ?? null

            return (
              <div
                key={`${title}-${ip}-${idx}`}
                className={`rounded-md border ${border} ${bg} px-2 py-1.5`}
              >
                <div className="font-mono text-xs text-slate-200">{ip || '(ip 없음)'}</div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-300">
                  {refName ? <span>{refName}</span> : <span className="text-slate-400">(targetRef 없음)</span>}
                  {nodeName ? <span className="text-slate-400">{`node=${nodeName}`}</span> : null}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {renderList('Ready targets (max 50)', endpoint.ready_targets, endpoint.ready_addresses, 'success')}
      {renderList('Not-ready targets (max 50)', endpoint.not_ready_targets, endpoint.not_ready_addresses, 'warning')}
    </div>
  )
}

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

  const heuristics = useMemo(() => {
    if (!selectedService) return []

    const hasSelector = Object.keys(selectedService.selector || {}).length > 0
    // ExternalName has no endpoints by design
    if (selectedService.type === 'ExternalName') return []

    const endpoint = related.endpoints
    const endpointTotal = endpoint ? (endpoint.ready_count || 0) + (endpoint.not_ready_count || 0) : 0
    const endpointReady = endpoint ? (endpoint.ready_count || 0) : 0

    const slices = related.endpointSlices || []
    const sliceTotal = slices.reduce((sum, s) => sum + (s.endpoints_total || 0), 0)
    const sliceReady = slices.reduce((sum, s) => sum + (s.endpoints_ready || 0), 0)

    const warnings: Array<{ level: 'error' | 'warn'; title: string; detail?: string }> = []

    // Selector exists but endpoints empty
    if (hasSelector && Array.isArray(podsForService) && podsForService.length > 0 && endpointTotal === 0) {
      warnings.push({
        level: 'error',
        title: 'Selector는 매칭되는데 Endpoints가 비어있습니다',
        detail: 'Pod Ready/ReadinessProbe, Service targetPort, 또는 selector/label 불일치를 확인하세요.',
      })
    } else if (hasSelector && endpointTotal === 0 && sliceTotal > 0) {
      warnings.push({
        level: 'warn',
        title: 'Endpoints는 비어있는데 EndpointSlices는 존재합니다',
        detail: `EndpointSlices total=${sliceTotal}`,
      })
    } else if (hasSelector && endpointTotal === 0) {
      warnings.push({
        level: 'warn',
        title: 'Selector는 있는데 Endpoints가 비어있습니다',
        detail: 'selector가 매칭되는 Pod가 없거나, 아직 Ready가 아닐 수 있습니다.',
      })
    }

    // Endpoints vs slices mismatch
    if (endpointTotal > 0 && sliceTotal > 0 && endpointTotal !== sliceTotal) {
      warnings.push({
        level: 'warn',
        title: 'Endpoints와 EndpointSlices의 개수가 다릅니다',
        detail: `Endpoints=${endpointTotal}, EndpointSlices total=${sliceTotal}`,
      })
    }
    if (endpointReady !== sliceReady && (endpointReady > 0 || sliceReady > 0)) {
      warnings.push({
        level: 'warn',
        title: 'Ready Endpoints와 Ready EndpointSlices가 다릅니다',
        detail: `Endpoints ready=${endpointReady}, EndpointSlices ready=${sliceReady}`,
      })
    }

    // Service port name vs Endpoints port name mismatch (best-effort)
    if (endpoint && Array.isArray((endpoint as any).ports) && (endpoint as any).ports.length > 0) {
      const endpointPorts = (endpoint as any).ports as Array<any>
      for (const sp of selectedService.ports || []) {
        const svcPortName = (sp as any).name as string | undefined
        if (svcPortName) {
          const ok = endpointPorts.some((ep) => ep?.name === svcPortName)
          if (!ok) {
            warnings.push({
              level: 'warn',
              title: `Service port name(${svcPortName})가 Endpoints port에 없습니다`,
              detail: 'port name/targetPort 불일치 가능성이 있습니다.',
            })
          }
        }
      }
    }

    // targetPort mismatch vs pod container ports (best-effort)
    if (hasSelector && Array.isArray(podsForService) && podsForService.length > 0) {
      const containerPortNumbers = new Set<number>()
      const containerPortNames = new Set<string>()

      for (const pod of podsForService) {
        for (const c of pod.containers || []) {
          const ports = (c as any).ports
          if (!Array.isArray(ports)) continue
          for (const p of ports) {
            if (typeof p?.container_port === 'number') containerPortNumbers.add(p.container_port)
            if (typeof p?.name === 'string' && p.name) containerPortNames.add(p.name)
          }
        }
      }

      const slicePortNumbers = new Set<number>()
      const slicePortNames = new Set<string>()
      for (const s of slices) {
        const ports = (s as any).ports
        if (!Array.isArray(ports)) continue
        for (const p of ports) {
          const port = p?.port
          const name = p?.name
          if (typeof port === 'number') slicePortNumbers.add(port)
          if (typeof name === 'string' && name) slicePortNames.add(name)
        }
      }

      const canValidateAgainstContainerPorts = containerPortNumbers.size > 0 || containerPortNames.size > 0

      for (const sp of selectedService.ports || []) {
        const targetPortRaw = (sp as any).target_port as string | undefined
        if (!targetPortRaw) continue

        if (isNumeric(targetPortRaw)) {
          const num = Number(targetPortRaw)
          // If containerPort is declared, validate against it (strong signal).
          // EndpointSlice ports can mirror Service spec, so they don't guarantee the container listens.
          if (Number.isFinite(num) && canValidateAgainstContainerPorts && !containerPortNumbers.has(num)) {
            const declared = containerPortNumbers.size > 0 ? `declared containerPorts: ${Array.from(containerPortNumbers).sort((a, b) => a - b).join(', ')}` : ''
            warnings.push({
              level: 'warn',
              title: `targetPort(${targetPortRaw})가 Pod containerPort에 없습니다`,
              detail: `Service가 실제 컨테이너 포트로 라우팅되지 않을 수 있습니다.${declared ? ` (${declared})` : ''}`,
            })
            continue
          }
          // If we can't validate via containerPort declarations, avoid noisy warnings when EndpointSlice already exists for that port.
          if (Number.isFinite(num) && !canValidateAgainstContainerPorts && slicePortNumbers.has(num)) continue
        } else {
          if (canValidateAgainstContainerPorts && !containerPortNames.has(targetPortRaw)) {
            const declared = containerPortNames.size > 0 ? `declared port names: ${Array.from(containerPortNames).sort().join(', ')}` : ''
            warnings.push({
              level: 'warn',
              title: `targetPort name(${targetPortRaw})가 Pod port name에 없습니다`,
              detail: `Service가 named port로 라우팅되지 않을 수 있습니다.${declared ? ` (${declared})` : ''}`,
            })
            continue
          }
          if (!canValidateAgainstContainerPorts && slicePortNames.has(targetPortRaw)) continue
        }
      }
    }

    return warnings
  }, [podsForService, related.endpoints, related.endpointSlices, selectedService])

  const policySummary = useMemo(() => {
    const policies = related.networkPolicies || []
    const ingressIsolationOn = policies.some((p) => (p.policy_types || []).includes('Ingress'))
    const egressIsolationOn = policies.some((p) => (p.policy_types || []).includes('Egress'))
    const totalIngressRules = policies.reduce((sum, p) => sum + (p.ingress_rules || 0), 0)
    const totalEgressRules = policies.reduce((sum, p) => sum + (p.egress_rules || 0), 0)
    const ingressEffectiveDenyAll = ingressIsolationOn && totalIngressRules === 0
    const egressEffectiveDenyAll = egressIsolationOn && totalEgressRules === 0
    const namespaceDefaultDenyIngress = policies.some((p) => p.selects_all_pods && p.default_deny_ingress)
    const namespaceDefaultDenyEgress = policies.some((p) => p.selects_all_pods && p.default_deny_egress)

    return {
      ingressIsolationOn,
      egressIsolationOn,
      ingressEffectiveDenyAll,
      egressEffectiveDenyAll,
      namespaceDefaultDenyIngress,
      namespaceDefaultDenyEgress,
    }
  }, [related.networkPolicies])

  const ingressDetailNames = useMemo(() => {
    const list = related.ingresses || []
    return list.map((i) => i.name).sort()
  }, [related.ingresses])

  const { data: ingressDetails } = useQuery({
    queryKey: ['network', 'ingressDetails', namespace, ingressDetailNames.join(',')],
    queryFn: async () => {
      if (!namespace) return []
      if (ingressDetailNames.length === 0) return []
      const results = await Promise.all(ingressDetailNames.map((n) => api.getIngressDetail(namespace, n)))
      return results as IngressDetail[]
    },
    enabled: !!namespace && ingressDetailNames.length > 0,
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
                        {renderEndpointTargets(related.endpoints)}
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

                <div className="bg-slate-800/60 rounded-lg border border-slate-700 p-4">
                  <div className="text-sm font-semibold text-white mb-2">Ingress</div>
                  {related.ingresses.length === 0 ? (
                    <div className="text-sm text-slate-400">(없음)</div>
                  ) : (
                    <div className="space-y-3">
                      {related.ingresses.map((ing) => {
                        const detail = (ingressDetails ?? []).find((d) => d.name === ing.name) ?? null
                        const klass =
                          (ingressClasses ?? []).find((c) => c.name === (detail?.class ?? ing.class ?? '')) ?? null
                        const addresses = (detail?.addresses || [])
                          .map((a) => a.ip || a.hostname)
                          .filter(Boolean)
                          .join(', ')
                        const tlsSecrets = (detail?.tls || [])
                          .map((t) => t.secret_name)
                          .filter(Boolean)
                          .join(', ')
                        const classSourceLabel =
                          detail?.class_source === 'spec'
                            ? 'spec'
                            : detail?.class_source === 'annotation'
                              ? 'annotation'
                              : detail?.class_source === 'default'
                                ? 'default candidate'
                                : null
                        return (
                          <div key={ing.name} className="rounded-md border border-slate-700 bg-slate-900/30 p-3">
                            <div className="flex items-center justify-between gap-3">
                              <div className="font-medium text-slate-100 truncate">{ing.name}</div>
                              <div className="text-xs text-slate-400">
                                class: {detail?.class || ing.class || '(none)'}
                                {classSourceLabel ? ` (${classSourceLabel})` : ''}
                                {detail?.class_is_default || klass?.is_default ? ' (default)' : ''}
                              </div>
                            </div>
                            {addresses ? (
                              <div className="mt-2 text-[11px] text-slate-400">address: {addresses}</div>
                            ) : (
                              <div className="mt-2 text-[11px] text-slate-500">address: (없음)</div>
                            )}
                            {tlsSecrets ? (
                              <div className="mt-1 text-[11px] text-slate-400">tls secret: {tlsSecrets}</div>
                            ) : (
                              <div className="mt-1 text-[11px] text-slate-500">tls secret: (없음)</div>
                            )}
                            <div className="mt-2 text-xs text-slate-300 whitespace-pre-wrap break-words">
                              {(detail?.rules || []).length > 0
                                ? detail!.rules
                                    .flatMap((r) =>
                                      (r.paths || []).map((p) => {
                                        const host = r.host || '*'
                                        const path = p.path || '/'
                                        const pathType = p.path_type ? ` (${p.path_type})` : ''
                                        const backend = (p.backend && p.backend.service && p.backend.service.name)
                                          ? ` → ${p.backend.service.name}:${p.backend.service.port ?? ''}`
                                          : ''
                                        return `${host} ${path}${pathType}${backend}`
                                      })
                                    )
                                    .join('\n') || '(rules 없음)'
                                : (ing.hosts || []).join('\n') || '(hosts 없음)'}
                            </div>
                            <div className="mt-2 text-[11px] text-slate-400">
                              controller: {detail?.class_controller || klass?.controller || '(unknown)'}
                            </div>
                            {(detail?.events || []).length > 0 ? (
                              <div className="mt-2 border-t border-slate-700 pt-2">
                                <div className="text-[11px] text-slate-400 mb-1">events (latest)</div>
                                <div className="space-y-1">
                                  {detail!.events.slice(0, 3).map((e, idx) => (
                                    <div key={idx} className="text-[11px] text-slate-300">
                                      [{e.type || ''}] {e.reason || ''}: {e.message || ''}{' '}
                                      {e.count ? `(x${e.count})` : ''}
                                    </div>
                                  ))}
                                </div>
                              </div>
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
                      <div className="rounded-md border border-slate-700 bg-slate-900/20 p-3 text-xs text-slate-300">
                        <div className="flex flex-wrap gap-2">
                          <span className={`badge ${policySummary.ingressIsolationOn ? 'badge-warning' : 'badge-success'}`}>
                            Ingress isolation: {policySummary.ingressIsolationOn ? 'ON' : 'OFF'}
                          </span>
                          <span className={`badge ${policySummary.egressIsolationOn ? 'badge-warning' : 'badge-success'}`}>
                            Egress isolation: {policySummary.egressIsolationOn ? 'ON' : 'OFF'}
                          </span>
                          {policySummary.ingressEffectiveDenyAll ? (
                            <span className="badge badge-error">Ingress: deny-all</span>
                          ) : null}
                          {policySummary.egressEffectiveDenyAll ? (
                            <span className="badge badge-error">Egress: deny-all</span>
                          ) : null}
                          {policySummary.namespaceDefaultDenyIngress ? (
                            <span className="badge badge-info">ns default-deny ingress policy present</span>
                          ) : null}
                          {policySummary.namespaceDefaultDenyEgress ? (
                            <span className="badge badge-info">ns default-deny egress policy present</span>
                          ) : null}
                        </div>
                        <div className="mt-2 text-[11px] text-slate-400">
                          ON이면 “허용 규칙의 합(Union)”만 통과합니다. (CNI/클러스터 설정에 따라 실제 동작은 달라질 수 있음)
                        </div>
                      </div>

                      {related.networkPolicies.map((p) => (
                        <div key={p.name} className="rounded-md border border-slate-700 bg-slate-900/30 p-3">
                          <div className="flex items-center justify-between gap-3">
                            <div className="font-medium text-slate-100 truncate">{p.name}</div>
                            <div className="text-xs text-slate-400">{(p.policy_types || []).join(', ') || ''}</div>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2 text-xs">
                            {p.default_deny_ingress ? <span className="badge badge-error">default-deny ingress</span> : null}
                            {p.default_deny_egress ? <span className="badge badge-error">default-deny egress</span> : null}
                            {p.selects_all_pods ? <span className="badge badge-info">selects all pods</span> : null}
                          </div>
                          <div className="mt-1 text-xs text-slate-300">
                            ingress rules: {p.ingress_rules} · egress rules: {p.egress_rules}
                          </div>
                          <div className="mt-2 text-[11px] text-slate-400">
                            selector:{' '}
                            {selectorToInline(p.pod_selector as any, 'all pods')}
                          </div>

                          {(p.ingress && p.ingress.length > 0) || p.default_deny_ingress ? (
                            <div className="mt-3">
                              <div className="text-[11px] text-slate-400 mb-1">Ingress allow</div>
                              {p.ingress && p.ingress.length > 0 ? (
                                <div className="space-y-2">
                                  {p.ingress.slice(0, 2).map((r, idx) => {
                                    const peers = Array.isArray(r.from) ? r.from : []
                                    const from = peers.length === 0 ? '(all sources)' : peers.slice(0, 2).map(formatPeer).join(' | ')
                                    const ports = formatPorts(r.ports)
                                    return (
                                      <div key={idx} className="text-[11px] text-slate-300">
                                        {from} · {ports}
                                      </div>
                                    )
                                  })}
                                  {p.ingress.length > 2 ? (
                                    <div className="text-[11px] text-slate-500">… +{p.ingress.length - 2} more ingress rules</div>
                                  ) : null}
                                </div>
                              ) : (
                                <div className="text-[11px] text-slate-500">(no ingress rules)</div>
                              )}
                            </div>
                          ) : null}

                          {(p.egress && p.egress.length > 0) || p.default_deny_egress ? (
                            <div className="mt-3">
                              <div className="text-[11px] text-slate-400 mb-1">Egress allow</div>
                              {p.egress && p.egress.length > 0 ? (
                                <div className="space-y-2">
                                  {p.egress.slice(0, 2).map((r, idx) => {
                                    const peers = Array.isArray(r.to) ? r.to : []
                                    const to = peers.length === 0 ? '(all destinations)' : peers.slice(0, 2).map(formatPeer).join(' | ')
                                    const ports = formatPorts(r.ports)
                                    return (
                                      <div key={idx} className="text-[11px] text-slate-300">
                                        {to} · {ports}
                                      </div>
                                    )
                                  })}
                                  {p.egress.length > 2 ? (
                                    <div className="text-[11px] text-slate-500">… +{p.egress.length - 2} more egress rules</div>
                                  ) : null}
                                </div>
                              ) : (
                                <div className="text-[11px] text-slate-500">(no egress rules)</div>
                              )}
                            </div>
                          ) : null}
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
