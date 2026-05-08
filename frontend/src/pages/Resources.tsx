import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/services/api'
import { useAIContext } from '@/hooks/useAIContext'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import {
  Server,
  Box,
  Database,
  RefreshCw,
  Layers,
  TrendingUp,
  Shield,
} from 'lucide-react'
import { HPATab } from './resources/HPATab'
import { PDBTab } from './resources/PDBTab'
import { SearchBar } from './resources/SearchBar'
import { TabNavigation } from './resources/TabNavigation'
import { useResourceQueries } from './resources/useResourceQueries'
import { compactSelector } from './resources/podHelpers'
import type { ResourceType } from './resources/types'

export default function Resources() {
  const queryClient = useQueryClient()
  const { namespace } = useParams<{ namespace: string }>()
  const [activeTab, setActiveTab] = useState<ResourceType>('deployments')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [podLabelSelector, setPodLabelSelector] = useState<string>('')

  const {
    services,
    deployments,
    replicasets,
    replicasetsError,
    hpas,
    hpasError,
    pdbs,
    pdbsError,
    podsForPdbs,
    pods,
    pvcs,
  } = useResourceQueries({ namespace, activeTab, podLabelSelector })

  // 플로팅 AI 위젯용 스냅샷 — 활성 탭 기준 단일 리스트 요약
  // 화면에서 검색 필터링이 적용된 결과의 상위 N 개를 visible_items 로 노출.
  // (Resources 페이지는 페이지네이션 없음 → currentPage=1, pageSize=topN)
  const aiSnapshot = useMemo(() => {
    if (!namespace) return null
    type TabConfig = {
      data: any[] | undefined
      kind: string
      pick: string[]
      problematic?: (it: any) => boolean
    }
    const tabConfig: Record<ResourceType, TabConfig> = {
      services: {
        data: services as any[] | undefined,
        kind: 'Service',
        pick: ['name', 'namespace', 'type', 'cluster_ip', 'ports'],
      },
      deployments: {
        data: deployments as any[] | undefined,
        kind: 'Deployment',
        pick: ['name', 'namespace', 'replicas', 'ready_replicas', 'available_replicas', 'status'],
        problematic: (d) => (d?.ready_replicas ?? 0) < (d?.replicas ?? 0),
      },
      replicasets: {
        data: replicasets as any[] | undefined,
        kind: 'ReplicaSet',
        pick: ['name', 'namespace', 'replicas', 'ready_replicas', 'desired'],
      },
      hpas: {
        data: hpas as any[] | undefined,
        kind: 'HorizontalPodAutoscaler',
        pick: ['name', 'namespace', 'min_replicas', 'max_replicas', 'current_replicas', 'target'],
      },
      pdbs: {
        data: pdbs as any[] | undefined,
        kind: 'PodDisruptionBudget',
        pick: ['name', 'namespace', 'min_available', 'max_unavailable', 'current_healthy', 'desired_healthy'],
      },
      pods: {
        data: pods as any[] | undefined,
        kind: 'Pod',
        pick: ['name', 'namespace', 'phase', 'status', 'restart_count', 'node_name'],
        problematic: (p) => {
          const ph = p?.phase || p?.status || ''
          if (ph !== 'Running' && ph !== 'Succeeded') return true
          if ((p?.restart_count ?? 0) > 5) return true
          return /error|crashloop|oomkilled|errimagepull|backoff/i.test(String(p?.status ?? ''))
        },
      },
      pvcs: {
        data: pvcs as any[] | undefined,
        kind: 'PersistentVolumeClaim',
        pick: ['name', 'namespace', 'status', 'capacity', 'storage_class', 'access_modes'],
        problematic: (p) => p?.status && p.status !== 'Bound',
      },
    }
    const cfg = tabConfig[activeTab]
    const allItems = Array.isArray(cfg.data) ? cfg.data : []
    // 검색 필터를 적용한 결과만 LLM 에 노출 (화면 일치성)
    const q = searchQuery.trim().toLowerCase()
    const filtered = q
      ? allItems.filter((it: any) => typeof it?.name === 'string' && it.name.toLowerCase().includes(q))
      : allItems
    const total = filtered.length
    const TOP_N = 15
    const summarized = summarizeList(filtered as Record<string, unknown>[], {
      total,
      currentPage: 1,
      pageSize: TOP_N,
      topN: TOP_N,
      pickFields: cfg.pick as any,
      filterProblematic: cfg.problematic as ((item: Record<string, unknown>) => boolean) | undefined,
    })
    // _link 추가 (드로어 자동 오픈용)
    const visibleItemsWithLinks = (summarized.visible_items as any[]).map((it) => ({
      ...it,
      _link: it?.name ? buildResourceLink(cfg.kind, it?.namespace ?? namespace, it.name) : undefined,
    }))

    return {
      source: 'base' as const,
      summary: `리소스 · ${namespace} · ${activeTab} ${total}개${q ? ` (검색: "${q}")` : ''}`,
      data: {
        namespace,
        active_tab: activeTab,
        filters: { search: searchQuery || undefined, pod_label_selector: podLabelSelector || undefined },
        stats: { total },
        ...summarized,
        visible_items: visibleItemsWithLinks,
      },
    }
  }, [namespace, activeTab, services, deployments, replicasets, hpas, pdbs, pods, pvcs, searchQuery, podLabelSelector])

  useAIContext(aiSnapshot, [aiSnapshot])

  const filterBySearch = (items: any[] | undefined | null) => {
    if (!Array.isArray(items)) return []
    if (!searchQuery.trim()) return items
    const q = searchQuery.toLowerCase()
    return items.filter((item) => 
      typeof item.name === 'string' && item.name.toLowerCase().includes(q)
    )
  }
  
  const filteredDeployments = filterBySearch(deployments)
  const filteredServices = filterBySearch(services)
  const filteredReplicaSets = filterBySearch(replicasets)
  const filteredHPAs = filterBySearch(hpas)
  const filteredPDBs = filterBySearch(pdbs)
  const filteredPods = filterBySearch(pods)
  const filteredPVCs = filterBySearch(pvcs)

  const getPodReason = (pod: any) => {
    const phase = (pod?.phase || '').toString()
    if (phase && phase !== 'Running') return phase

    const ready = (pod?.ready || '').toString()
    const m = ready.match(/^(\d+)\/(\d+)$/)
    const isNotReady = (() => {
      if (!m) return false
      const a = Number(m[1])
      const b = Number(m[2])
      if (Number.isNaN(a) || Number.isNaN(b) || b <= 0) return false
      return a !== b
    })()

    const containers = Array.isArray(pod?.containers) ? pod.containers : []
    const reasons: string[] = []

    for (const c of containers) {
      const waitingReason = c?.state?.waiting?.reason
      if (waitingReason) reasons.push(String(waitingReason))
    }
    for (const c of containers) {
      const terminatedReason = c?.state?.terminated?.reason || c?.last_state?.terminated?.reason
      if (terminatedReason) reasons.push(String(terminatedReason))
    }

    if (reasons.length > 0) {
      const priority = [
        'ImagePullBackOff',
        'ErrImagePull',
        'CrashLoopBackOff',
        'CreateContainerConfigError',
        'CreateContainerError',
        'RunContainerError',
        'OOMKilled',
        'Error',
        'ContainerCreating',
        'PodInitializing',
      ]
      const best = reasons
        .slice()
        .sort((a, b) => {
          const ai = priority.indexOf(a)
          const bi = priority.indexOf(b)
          const aa = ai === -1 ? 999 : ai
          const bb = bi === -1 ? 999 : bi
          if (aa !== bb) return aa - bb
          return a.localeCompare(b)
        })[0]
      return best || 'Unknown'
    }

    if (isNotReady) return 'NotReady'
    return 'Running'
  }

  const podTopSummary = useMemo(() => {
    if (activeTab !== 'pods') return null
    const list = Array.isArray(filteredPods) ? filteredPods : []
    if (list.length === 0) return { total: 0, topReasons: [] as Array<[string, number]>, phaseSummary: '' }

    const reasonCounts = new Map<string, number>()
    const phaseCounts = new Map<string, number>()

    for (const pod of list) {
      const reason = getPodReason(pod)
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1)

      const phase = (pod?.phase || pod?.status || 'Unknown').toString()
      phaseCounts.set(phase, (phaseCounts.get(phase) || 0) + 1)
    }

    const topReasons = Array.from(reasonCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)

    const phaseSummary = Array.from(phaseCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, v]) => `${k}:${v}`)
      .join(' · ')

    const hasIssue = topReasons.some(([r]) => r !== 'Running') || Array.from(phaseCounts.keys()).some((p) => p !== 'Running')
    return { total: list.length, topReasons, phaseSummary, hasIssue }
  }, [activeTab, filteredPods])

  const handleRefresh = async () => {
    setIsRefreshing(true)
    // 새로고침은 항상 강제 갱신
    try {
      let data: any
      if (activeTab === 'services') {
        data = await api.getServices(namespace!, true)
        queryClient.removeQueries({ queryKey: ['services', namespace] })
        queryClient.setQueryData(['services', namespace], data)
      } else if (activeTab === 'deployments') {
        data = await api.getDeployments(namespace!, true)
        queryClient.removeQueries({ queryKey: ['deployments', namespace] })
        queryClient.setQueryData(['deployments', namespace], data)
      } else if (activeTab === 'replicasets') {
        data = await api.getReplicaSets(namespace!, true)
        queryClient.removeQueries({ queryKey: ['replicasets', namespace] })
        queryClient.setQueryData(['replicasets', namespace], data)
      } else if (activeTab === 'hpas') {
        data = await api.getHPAs(namespace!, true)
        queryClient.removeQueries({ queryKey: ['hpas', namespace] })
        queryClient.setQueryData(['hpas', namespace], data)
      } else if (activeTab === 'pdbs') {
        data = await api.getPDBs(namespace!, true)
        queryClient.removeQueries({ queryKey: ['pdbs', namespace] })
        queryClient.setQueryData(['pdbs', namespace], data)
        const podData = await api.getPods(namespace!, undefined, true)
        queryClient.removeQueries({ queryKey: ['pods', namespace, '__for_pdbs__'] })
        queryClient.setQueryData(['pods', namespace, '__for_pdbs__'], podData)
      } else if (activeTab === 'pods') {
        data = await api.getPods(namespace!, podLabelSelector || undefined, true)
        queryClient.removeQueries({ queryKey: ['pods', namespace, podLabelSelector || ''] })
        queryClient.setQueryData(['pods', namespace, podLabelSelector || ''], data)
      } else if (activeTab === 'pvcs') {
        data = await api.getPVCs(namespace, true)
        queryClient.removeQueries({ queryKey: ['pvcs', namespace] })
        queryClient.setQueryData(['pvcs', namespace], data)
      }
    } catch (error) {
      console.error('새로고침 실패:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const tabs = [
    { id: 'deployments' as ResourceType, name: 'Deployments', icon: Server },
    { id: 'pods' as ResourceType, name: 'Pods', icon: Box },
    { id: 'services' as ResourceType, name: 'Services', icon: Database },
    { id: 'replicasets' as ResourceType, name: 'ReplicaSets', icon: Layers },
    { id: 'hpas' as ResourceType, name: 'HPA', icon: TrendingUp },
    { id: 'pdbs' as ResourceType, name: 'PDB', icon: Shield },
    { id: 'pvcs' as ResourceType, name: 'PVCs', icon: Database },
  ]

  const getStatusColor = (status: string) => {
    const statusLower = status.toLowerCase()
    if (statusLower.includes('running') || statusLower.includes('healthy') || statusLower.includes('active')) {
      return 'badge-success'
    }
    if (statusLower.includes('pending') || statusLower.includes('degraded')) {
      return 'badge-warning'
    }
    if (statusLower.includes('failed') || statusLower.includes('unavailable')) {
      return 'badge-error'
    }
    return 'badge-info'
  }

  const searchPlaceholder: Record<ResourceType, string> = {
    deployments: 'Deployment 이름 검색...',
    replicasets: 'ReplicaSet 이름 검색...',
    hpas: 'HPA 이름 검색...',
    pdbs: 'PDB 이름 검색...',
    services: 'Service 이름 검색...',
    pods: 'Pod 이름 검색...',
    pvcs: 'PVC 이름 검색...',
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">
            {namespace} 리소스
          </h1>
          <p className="mt-2 text-slate-400">
            네임스페이스의 모든 리소스를 확인하고 관리하세요
          </p>
        </div>
        <button 
          onClick={handleRefresh}
          disabled={isRefreshing}
          title="새로고침 (강제 갱신)"
          className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          새로고침
        </button>
      </div>

      <TabNavigation tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />

      <SearchBar
        activeTab={activeTab}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        podLabelSelector={podLabelSelector}
        onClearPodLabelSelector={() => setPodLabelSelector('')}
        searchPlaceholder={searchPlaceholder}
        counts={{
          services: filteredServices.length,
          deployments: filteredDeployments.length,
          replicasets: filteredReplicaSets.length,
          hpas: filteredHPAs.length,
          pdbs: filteredPDBs.length,
          pods: filteredPods.length,
          pvcs: filteredPVCs.length,
        }}
      />

      {/* Deployments */}
      {activeTab === 'deployments' && (
        <div className="space-y-4">
          {filteredDeployments.map((deploy) => (
            <div key={deploy.name} className="card">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-bold text-white">{deploy.name}</h3>
                  <p className="text-sm text-slate-400 mt-1">{deploy.image}</p>
                </div>
                <span className={`badge ${getStatusColor(deploy.status)}`}>
                  {deploy.status}
                </span>
              </div>
              <div className="mt-4 grid grid-cols-4 gap-4">
                <div>
                  <p className="text-xs text-slate-400">Replicas</p>
                  <p className="text-lg font-bold text-white">{deploy.replicas}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Ready</p>
                  <p className="text-lg font-bold text-white">{deploy.ready_replicas}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Available</p>
                  <p className="text-lg font-bold text-white">{deploy.available_replicas}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Updated</p>
                  <p className="text-lg font-bold text-white">{deploy.updated_replicas}</p>
                </div>
              </div>
            </div>
          ))}
          {filteredDeployments.length === 0 && (
            <div className="card">
              <div className="text-slate-400">(없음)</div>
            </div>
          )}
        </div>
      )}

      {/* ReplicaSets */}
      {activeTab === 'replicasets' && (
        <div className="space-y-4">
          {replicasetsError && (
            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4 text-sm text-yellow-200">
              ReplicaSet 조회에 실패했습니다. (클러스터 권한/버전에 따라 불가할 수 있습니다)
            </div>
          )}
          {filteredReplicaSets.map((rs: any) => (
            <div key={rs.name} className="card">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-bold text-white">{rs.name}</h3>
                  <p className="text-sm text-slate-400 mt-1">{rs.image || '-'}</p>
                  {rs.owner && <p className="text-xs text-slate-500 mt-1">Owner: {rs.owner}</p>}
                  {rs.selector && Object.keys(rs.selector).length > 0 && (() => {
                    const full = rs.selector || {}
                    const compact = compactSelector(full)
                    const fullText = Object.entries(full).map(([k, v]: any) => `${k}=${v}`).join(', ')
                    const compactText = Object.entries(compact).map(([k, v]: any) => `${k}=${v}`).join(', ')
                    return (
                      <p
                        className="text-xs text-slate-500 mt-1 font-mono break-words"
                        title={`전체 selector: ${fullText}`}
                      >
                        selector: {compactText}
                      </p>
                    )
                  })()}
                </div>
                <div className="flex flex-col items-end gap-2">
                  <span className={`badge ${getStatusColor(rs.status)}`}>
                    {rs.status}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const selectorObj = compactSelector(rs.selector || {})
                      const selector = Object.entries(selectorObj)
                        .map(([k, v]: any) => `${k}=${v}`)
                        .join(',')
                      setPodLabelSelector(selector)
                      setSearchQuery('')
                      setActiveTab('pods')
                    }}
                    disabled={!rs.selector || Object.keys(rs.selector).length === 0}
                    className="text-xs text-slate-300 hover:text-white border border-slate-600 rounded px-2 py-1 disabled:opacity-50 disabled:cursor-not-allowed"
                    title="ReplicaSet selector로 Pod 목록을 필터링합니다"
                  >
                    Pods로 이동
                  </button>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-4">
                <div>
                  <p className="text-xs text-slate-400">Replicas</p>
                  <p className="text-lg font-bold text-white">{rs.replicas}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Ready</p>
                  <p className="text-lg font-bold text-white">{rs.ready_replicas}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Available</p>
                  <p className="text-lg font-bold text-white">{rs.available_replicas}</p>
                </div>
              </div>
            </div>
          ))}
          {filteredReplicaSets.length === 0 && (
            <div className="card">
              <div className="text-slate-400">(없음)</div>
            </div>
          )}
        </div>
      )}

      {/* HPA */}
      <HPATab filteredHPAs={filteredHPAs} hpasError={hpasError} />

      {/* PDB */}
      {activeTab === 'pdbs' && (
        <PDBTab
          filteredPDBs={filteredPDBs}
          pdbsError={pdbsError}
          podsForPdbs={podsForPdbs as any[] | undefined}
          setPodLabelSelector={setPodLabelSelector}
          setSearchQuery={setSearchQuery}
          setActiveTab={setActiveTab}
        />
      )}

      {/* Services */}
      {activeTab === 'services' && (
        <div className="space-y-4">
          {filteredServices.map((svc) => (
            <div key={svc.name} className="card">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-bold text-white">{svc.name}</h3>
                  <p className="text-sm text-slate-400 mt-1">Type: {svc.type}</p>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-slate-400">Cluster IP</p>
                  <p className="text-sm font-mono text-white">{svc.cluster_ip || 'N/A'}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">External IP</p>
                  <p className="text-sm font-mono text-white">{svc.external_ip || 'none'}</p>
                </div>
              </div>
              {svc.ports && svc.ports.length > 0 && (
                <div className="mt-4">
                  <p className="text-xs text-slate-400 mb-2">Ports</p>
                  <div className="flex flex-wrap gap-2">
                    {svc.ports.map((port: any, idx: number) => (
                      <span key={idx} className="badge badge-info">
                        {port.port}:{port.target_port}/{port.protocol}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
          {filteredServices.length === 0 && (
            <div className="card">
              <div className="text-slate-400">(없음)</div>
            </div>
          )}
        </div>
      )}

      {/* Pods */}
      {activeTab === 'pods' && (
        <div className="space-y-4">
          {podTopSummary && podTopSummary.total > 0 && (podLabelSelector || searchQuery || podTopSummary.hasIssue) && (
            <div className="bg-slate-900/40 border border-slate-700 rounded-lg p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm text-white font-semibold">Top reason 요약</div>
                <div className="text-xs text-slate-400">pods: {podTopSummary.total}</div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {podTopSummary.topReasons.map(([reason, count]) => (
                  <span
                    key={reason}
                    className={`badge font-mono ${
                      reason === 'Running' ? 'badge-success' : reason === 'NotReady' ? 'badge-warning' : 'badge-warning'
                    }`}
                    title={reason}
                  >
                    {reason}:{count}
                  </span>
                ))}
              </div>
              {podTopSummary.phaseSummary && (
                <div className="mt-2 text-xs text-slate-500 font-mono">phase: {podTopSummary.phaseSummary}</div>
              )}
            </div>
          )}
          {filteredPods.map((pod) => (
            <div key={pod.name} className="card">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-bold text-white">{pod.name}</h3>
                  <p className="text-sm text-slate-400 mt-1">Node: {pod.node_name || 'N/A'}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`badge ${getStatusColor(pod.status)}`}>
                    {pod.status}
                  </span>
                  {pod.restart_count > 0 && (
                    <span className="badge badge-warning">
                      재시작: {pod.restart_count}
                    </span>
                  )}
                </div>
              </div>
              <div className="mt-4 grid grid-cols-4 gap-4">
                <div>
                  <p className="text-xs text-slate-400">Phase</p>
                  <p className="text-sm text-white">{pod.phase}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">IP</p>
                  <p className="text-sm font-mono text-white">{pod.pod_ip || 'N/A'}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Ready</p>
                  <p className="text-sm text-white">{pod.ready}</p>
                </div>
              </div>
            </div>
          ))}
          {filteredPods.length === 0 && (
            <div className="card">
              <div className="text-slate-400">(없음)</div>
            </div>
          )}
        </div>
      )}

      {/* PVCs */}
      {activeTab === 'pvcs' && (
        <div className="space-y-4">
          {filteredPVCs.map((pvc) => (
            <div key={`${pvc.namespace}-${pvc.name}`} className="card">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-bold text-white">{pvc.name}</h3>
                  <p className="text-sm text-slate-400 mt-1">
                    Namespace: {pvc.namespace}
                  </p>
                </div>
                <span className={`badge ${getStatusColor(pvc.status)}`}>
                  {pvc.status}
                </span>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-4">
                <div>
                  <p className="text-xs text-slate-400">Capacity</p>
                  <p className="text-sm text-white">{pvc.capacity || 'N/A'}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Requested</p>
                  <p className="text-sm text-white">{pvc.requested || 'N/A'}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Storage Class</p>
                  <p className="text-sm text-white">{pvc.storage_class || 'N/A'}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Volume</p>
                  <p className="text-sm font-mono text-white">{pvc.volume_name || 'N/A'}</p>
                </div>
              </div>
            </div>
          ))}
          {filteredPVCs.length === 0 && (
            <div className="card">
              <div className="text-slate-400">(없음)</div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
