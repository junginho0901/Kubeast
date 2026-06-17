import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
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
import { PodTab } from './resources/PodTab'
import { SearchBar } from './resources/SearchBar'
import { TabNavigation } from './resources/TabNavigation'
import { useResourceQueries } from './resources/useResourceQueries'
import { compactSelector } from './resources/podHelpers'
import type { ResourceType } from './resources/types'

export default function Resources() {
  const { t } = useTranslation()
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
    deployments: t('resources.searchPlaceholder', { kind: 'Deployment' }),
    replicasets: t('resources.searchPlaceholder', { kind: 'ReplicaSet' }),
    hpas: t('resources.searchPlaceholder', { kind: 'HPA' }),
    pdbs: t('resources.searchPlaceholder', { kind: 'PDB' }),
    services: t('resources.searchPlaceholder', { kind: 'Service' }),
    pods: t('resources.searchPlaceholder', { kind: 'Pod' }),
    pvcs: t('resources.searchPlaceholder', { kind: 'PVC' }),
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">
            {t('resources.title', { namespace })}
          </h1>
          <p className="mt-2 text-slate-400">
            {t('resources.subtitle')}
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={isRefreshing}
          title={t('common.refreshForce')}
          className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          {t('common.refresh')}
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
              <div className="text-slate-400">{t('common.none')}</div>
            </div>
          )}
        </div>
      )}

      {/* ReplicaSets */}
      {activeTab === 'replicasets' && (
        <div className="space-y-4">
          {replicasetsError && (
            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4 text-sm text-yellow-200">
              {t('resources.replicasetError')}
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
                        title={t('resources.fullSelectorTitle', { selector: fullText })}
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
                    title={t('resources.gotoPodsTitle')}
                  >
                    {t('resources.gotoPods')}
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
              <div className="text-slate-400">{t('common.none')}</div>
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
              <div className="text-slate-400">{t('common.none')}</div>
            </div>
          )}
        </div>
      )}

      {/* Pods */}
      {activeTab === 'pods' && (
        <PodTab
          filteredPods={filteredPods}
          podLabelSelector={podLabelSelector}
          searchQuery={searchQuery}
          getStatusColor={getStatusColor}
        />
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
              <div className="text-slate-400">{t('common.none')}</div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
