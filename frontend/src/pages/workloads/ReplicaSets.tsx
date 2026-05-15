import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type ReplicaSetInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { useAIContext } from '@/hooks/useAIContext'
import { usePermission } from '@/hooks/usePermission'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import { Plus, RefreshCw } from 'lucide-react'
import {
  parseAgeSeconds,
  type SortKey,
} from './replicasets/replicaSetHelpers'
import { applyReplicaSetWatchEvent } from './replicasets/replicaSetWatchNormalize'
import { ReplicaSetFilters } from './replicasets/ReplicaSetFilters'
import { ReplicaSetTable } from './replicasets/ReplicaSetTable'

export default function ReplicaSets() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const { open: openDetail } = useResourceDetail()

  const [searchQuery, setSearchQuery] = useState('')
  const [selectedNamespace, setSelectedNamespace] = useState<string>('all')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [currentPage, setCurrentPage] = useState(1)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)

  const { data: namespaces } = useQuery({
    queryKey: ['namespaces'],
    queryFn: () => api.getNamespaces(),
    staleTime: 30000,
  })

  const { data: replicasets, isLoading } = useQuery({
    queryKey: ['workloads', 'replicasets', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllReplicaSets(false)
        : api.getReplicaSets(selectedNamespace, false)
    ),
  })
  const { has } = usePermission()
  const canCreate = has('resource.replicaset.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['workloads', 'replicasets', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/api/v1/replicasets'
      : `/api/v1/namespaces/${selectedNamespace}/replicasets`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyReplicaSetWatchEvent(prev as ReplicaSetInfo[] | undefined, event),
  })

  const filteredReplicaSets = useMemo(() => {
    if (!Array.isArray(replicasets)) return [] as ReplicaSetInfo[]
    if (!searchQuery.trim()) return replicasets
    const q = searchQuery.toLowerCase()
    return replicasets.filter((rs) => {
      const imagesText = (rs.images || []).join(',')
      const containersText = (rs.container_names || []).join(',')
      const selectorText = Object.entries(rs.selector || {}).map(([k, v]) => `${k}=${v}`).join(',')
      return rs.name.toLowerCase().includes(q)
        || rs.namespace.toLowerCase().includes(q)
        || (rs.owner || '').toLowerCase().includes(q)
        || (rs.status || '').toLowerCase().includes(q)
        || imagesText.toLowerCase().includes(q)
        || containersText.toLowerCase().includes(q)
        || selectorText.toLowerCase().includes(q)
    })
  }, [replicasets, searchQuery])

  const summary = useMemo(() => {
    const total = filteredReplicaSets.length
    let healthy = 0
    let idle = 0
    let degraded = 0
    let unavailable = 0
    for (const rs of filteredReplicaSets) {
      const status = (rs.status || '').toLowerCase()
      // backend workloads_formatters.go 는 "Healthy" / "Idle" (replicas=0) /
      // "Degraded" / "Unavailable" 4 값을 보냄. ReplicaSet 은 deployment rollout
      // 마다 old-generation RS 가 replicas=0 으로 누적되어 Idle 이 매우 많음
      // (deployment 1개 = RS N개 중 N-1개가 Idle). Healthy 에 합산하면 카운트가
      // 부풀려져서 (e.g. 12 active vs 200+ idle) 운영 가시성이 떨어지므로 별도
      // 카드로 분리 — DS/STS/Job 과 다른 layout (4→5 카드).
      if (status.includes('healthy')) healthy += 1
      else if (status.includes('idle')) idle += 1
      else if (status.includes('unavailable')) unavailable += 1
      else degraded += 1
    }
    return { total, healthy, idle, degraded, unavailable }
  }, [filteredReplicaSets])

  const sortedReplicaSets = useMemo(() => {
    if (!sortKey) return filteredReplicaSets
    const list = [...filteredReplicaSets]

    const getValue = (rs: ReplicaSetInfo): string | number => {
      switch (sortKey) {
        case 'name':
          return rs.name
        case 'current':
          return rs.current_replicas || 0
        case 'desired':
          return rs.replicas || 0
        case 'ready':
          return rs.ready_replicas || 0
        case 'available':
          return rs.available_replicas || 0
        case 'status':
          return rs.status || ''
        case 'containers':
          return (rs.container_names || []).join(',')
        case 'images':
          return (rs.images || []).join(',')
        case 'selector':
          return Object.entries(rs.selector || {}).map(([k, v]) => `${k}=${v}`).join(',')
        case 'age':
          return parseAgeSeconds(rs.created_at)
        default:
          return ''
      }
    }

    list.sort((a, b) => {
      const av = getValue(a)
      const bv = getValue(b)
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av
      }
      return sortDir === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av))
    })

    return list
  }, [filteredReplicaSets, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedReplicaSets.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedReplicaSets.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const pagedReplicaSets = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedReplicaSets.slice(start, start + rowsPerPage)
  }, [sortedReplicaSets, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(replicasets) || replicasets.length === 0) return null
    const nsLabel = selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace
    const total = replicasets.length
    return {
      source: 'base' as const,
      summary: `${nsLabel} ReplicaSet ${total}개`,
      data: {
        filters: { namespace: selectedNamespace, search: searchQuery || undefined },
        stats: { total },
        ...summarizeList(pagedReplicaSets as unknown as Record<string, unknown>[], {
          total: sortedReplicaSets.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace', 'replicas', 'ready_replicas', 'available_replicas', 'owner', 'status'],
          linkBuilder: (r) => {
            const rs = r as unknown as ReplicaSetInfo
            return buildResourceLink('ReplicaSet', rs.namespace, rs.name)
          },
        }),
      },
    }
  }, [replicasets, pagedReplicaSets, sortedReplicaSets.length, currentPage, rowsPerPage, selectedNamespace, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllReplicaSets(true)
        : await api.getReplicaSets(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['workloads', 'replicasets', selectedNamespace] })
      queryClient.setQueryData(['workloads', 'replicasets', selectedNamespace], data)
    } catch (error) {
      console.error('ReplicaSets refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createReplicaSetYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: apps/v1
kind: ReplicaSet
metadata:
  name: sample-replicaset
  namespace: ${ns}
  labels:
    app: sample-replicaset
spec:
  replicas: 2
  selector:
    matchLabels:
      app: sample-replicaset
  template:
    metadata:
      labels:
        app: sample-replicaset
    spec:
      containers:
        - name: sample
          image: nginx:stable
          ports:
            - containerPort: 80
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('replicasets.title', 'Replica Sets')}</h1>
          <p className="mt-2 text-slate-400">{tr('replicasets.subtitle', 'Inspect and manage ReplicaSets across namespaces.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('replicasets.create', 'Create ReplicaSet')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('replicasets.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('replicasets.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <ReplicaSetFilters
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        selectedNamespace={selectedNamespace}
        setSelectedNamespace={setSelectedNamespace}
        namespaces={namespaces}
        searchPlaceholder={tr('replicasets.searchPlaceholder', 'Search replicasets by name...')}
        allNamespacesLabel={tr('replicasets.allNamespaces', 'All namespaces')}
      />

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('replicasets.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('replicasets.stats.healthy', 'Healthy')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.healthy}</p>
        </div>
        <div className="rounded-lg border border-slate-600/50 bg-slate-800/30 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-300">{tr('replicasets.stats.idle', 'Idle')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.idle}</p>
        </div>
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-amber-300">{tr('replicasets.stats.degraded', 'Degraded')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.degraded}</p>
        </div>
        <div className="rounded-lg border border-red-700/40 bg-red-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-red-300">{tr('replicasets.stats.unavailable', 'Unavailable')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.unavailable}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('replicasets.matchCount', '{{count}} replicaset{{suffix}} match.', {
            count: filteredReplicaSets.length,
            suffix: filteredReplicaSets.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <ReplicaSetTable
        pagedReplicaSets={pagedReplicaSets}
        sortedReplicaSetsLength={sortedReplicaSets.length}
        isLoading={isLoading}
        showNamespaceColumn={showNamespaceColumn}
        sortKey={sortKey}
        setSortKey={setSortKey}
        sortDir={sortDir}
        setSortDir={setSortDir}
        currentPage={currentPage}
        setCurrentPage={setCurrentPage}
        totalPages={totalPages}
        rowsPerPage={rowsPerPage}
        tableContainerRef={tableContainerRef}
        tableBodyRef={tableBodyRef}
        theadRef={theadRef}
        firstRowRef={firstRowRef}
        openDetail={openDetail}
        tr={tr}
      />

      {createDialogOpen && (
        <ResourceYamlCreateDialog
          title={tr('replicasets.createTitle', 'Create ReplicaSet from YAML')}
          initialYaml={createReplicaSetYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['workloads', 'replicasets'] })
          }}
        />
      )}
    </div>
  )
}
