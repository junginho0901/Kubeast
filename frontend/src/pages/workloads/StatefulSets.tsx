import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Plus, RefreshCw } from 'lucide-react'
import { api, type StatefulSetInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAIContext } from '@/hooks/useAIContext'
import { usePermission } from '@/hooks/usePermission'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import { parseAgeSeconds, type SortKey } from './statefulsets/statefulSetHelpers'
import { StatefulSetFilters } from './statefulsets/StatefulSetFilters'
import { StatefulSetTable } from './statefulsets/StatefulSetTable'

export default function StatefulSets() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const { open: openDetail } = useResourceDetail()

  const [searchQuery, setSearchQuery] = useState('')
  const [selectedNamespace, setSelectedNamespace] = useState<string>('all')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(12)
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const { has } = usePermission()
  const canWrite = has('resource.statefulset.create')

  const { data: namespaces } = useQuery({
    queryKey: ['namespaces'],
    queryFn: () => api.getNamespaces(),
  })

  const listQueryKey = ['workloads', 'statefulsets', selectedNamespace]
  const { data: statefulsets, isLoading } = useQuery({
    queryKey: listQueryKey,
    queryFn: () => {
      if (selectedNamespace === 'all') return api.getAllStatefulSets(false)
      return api.getStatefulSets(selectedNamespace, false)
    },
  })

  useKubeWatchList({
    enabled: true,
    queryKey: listQueryKey,
    path: selectedNamespace === 'all'
      ? '/api/v1/statefulsets'
      : `/api/v1/namespaces/${selectedNamespace}/statefulsets`,
    query: 'watch=1',
    onEvent: (event) => {
      const name = event?.object?.name
      const ns = event?.object?.namespace
      if (name && ns) {
        queryClient.invalidateQueries({ queryKey: ['statefulset-describe', ns, name] })
      }
    },
  })

  useEffect(() => {
    const handleResize = () => {
      const viewportHeight = window.innerHeight
      const estimatedRowHeight = 45
      const reservedHeight = 380
      const next = Math.max(8, Math.floor((viewportHeight - reservedHeight) / estimatedRowHeight))
      setPageSize(next)
    }
    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const filtered = useMemo(() => {
    const items = Array.isArray(statefulsets) ? statefulsets : []
    if (!searchQuery.trim()) return items
    const q = searchQuery.toLowerCase()
    return items.filter((sts) => sts.name.toLowerCase().includes(q))
  }, [statefulsets, searchQuery])

  const summary = useMemo(() => {
    const items = Array.isArray(filtered) ? filtered : []
    const total = items.length
    let healthy = 0
    let idle = 0
    let degraded = 0
    let unavailable = 0
    for (const item of items) {
      const s = String(item.status || '').toLowerCase()
      // backend workloads_formatters.go 는 "Healthy" / "Idle" (replicas=0) /
      // "Degraded" / "Unavailable" 4 값을 보냄. Idle 은 사용자가 인지해야 할
      // 비활성 상태이므로 별도 카드 (5 카드 layout, ReplicaSets/DaemonSets 와 동일).
      if (s.includes('healthy')) healthy += 1
      else if (s.includes('idle')) idle += 1
      else if (s.includes('unavailable')) unavailable += 1
      else degraded += 1
    }
    return { total, healthy, idle, degraded, unavailable }
  }, [filtered])

  const sorted = useMemo(() => {
    if (!sortKey) return filtered
    const list = [...filtered]
    const getValue = (sts: StatefulSetInfo): string | number => {
      switch (sortKey) {
        case 'name':
          return sts.name
        case 'ready':
          return (sts.replicas || 0) === 0 ? 0 : (sts.ready_replicas || 0) / (sts.replicas || 1)
        case 'upToDate':
          return (sts.replicas || 0) === 0 ? 0 : (sts.updated_replicas ?? sts.current_replicas ?? 0) / (sts.replicas || 1)
        case 'available':
          return sts.available_replicas || 0
        case 'status':
          return String(sts.status || '')
        case 'age':
          return parseAgeSeconds(sts.created_at)
        case 'service':
          return String(sts.service_name || '')
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
  }, [filtered, sortKey, sortDir])

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace, pageSize])
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const paged = useMemo(() => {
    const start = (currentPage - 1) * pageSize
    return sorted.slice(start, start + pageSize)
  }, [sorted, currentPage, pageSize])

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(statefulsets) || statefulsets.length === 0) return null
    const nsLabel = selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace
    const unhealthy = summary.degraded + summary.unavailable
    const prefix = summary.unavailable > 0 ? '⚠️ ' : ''
    return {
      source: 'base' as const,
      summary: `${prefix}${nsLabel} StatefulSet ${summary.total}개 (Healthy ${summary.healthy}${unhealthy ? `, 문제 ${unhealthy}` : ''})`,
      data: {
        filters: { namespace: selectedNamespace, search: searchQuery || undefined },
        stats: summary,
        ...summarizeList(paged as unknown as Record<string, unknown>[], {
          total: filtered.length,
          currentPage,
          pageSize,
          topN: pageSize,
          pickFields: ['name', 'namespace', 'replicas', 'ready_replicas', 'available_replicas', 'status'],
          filterProblematic: (s) => {
            const st = String((s as unknown as StatefulSetInfo).status || '').toLowerCase()
            return st.includes('unavailable') || st.includes('degraded')
          },
          linkBuilder: (s) => {
            const sts = s as unknown as StatefulSetInfo
            return buildResourceLink('StatefulSet', sts.namespace, sts.name)
          },
        }),
      },
    }
  }, [statefulsets, paged, filtered.length, currentPage, pageSize, selectedNamespace, searchQuery, summary])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllStatefulSets(true)
        : await api.getStatefulSets(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: listQueryKey })
      queryClient.setQueryData(listQueryKey, data)
    } catch (error) {
      console.error('StatefulSets refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const initialYaml = useMemo(() => (
`apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: example-statefulset
  namespace: ${selectedNamespace === 'all' ? 'default' : selectedNamespace}
spec:
  serviceName: example-service
  replicas: 1
  selector:
    matchLabels:
      app: example
  template:
    metadata:
      labels:
        app: example
    spec:
      containers:
        - name: app
          image: nginx:stable
          ports:
            - containerPort: 80
`
  ), [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('statefulsets.title', 'Stateful Sets')}</h1>
          <p className="mt-2 text-slate-400">{tr('statefulsets.subtitle', 'Inspect and manage StatefulSets across namespaces.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canWrite && (
            <button
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('statefulsets.create', 'Create StatefulSet')}
            </button>
          )}
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('statefulsets.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('statefulsets.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <StatefulSetFilters
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        selectedNamespace={selectedNamespace}
        setSelectedNamespace={setSelectedNamespace}
        namespaces={namespaces}
        searchPlaceholder={tr('statefulsets.searchPlaceholder', 'Search StatefulSets by name...')}
        allNamespacesLabel={tr('statefulsets.allNamespaces', 'All namespaces')}
      />

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-xs text-slate-400">{tr('statefulsets.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-xs text-emerald-300">{tr('statefulsets.stats.healthy', 'Healthy')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.healthy}</p>
        </div>
        <div className="rounded-lg border border-slate-600/50 bg-slate-800/30 px-4 py-3">
          <p className="text-xs text-slate-300">{tr('statefulsets.stats.idle', 'Idle')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.idle}</p>
        </div>
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/10 px-4 py-3">
          <p className="text-xs text-amber-300">{tr('statefulsets.stats.degraded', 'Degraded')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.degraded}</p>
        </div>
        <div className="rounded-lg border border-red-700/40 bg-red-900/10 px-4 py-3">
          <p className="text-xs text-red-300">{tr('statefulsets.stats.unavailable', 'Unavailable')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.unavailable}</p>
        </div>
      </div>

      <StatefulSetTable
        paged={paged}
        filteredLength={filtered.length}
        isLoading={isLoading}
        showNamespaceColumn={showNamespaceColumn}
        sortKey={sortKey}
        setSortKey={setSortKey}
        sortDir={sortDir}
        setSortDir={setSortDir}
        currentPage={currentPage}
        setCurrentPage={setCurrentPage}
        totalPages={totalPages}
        pageSize={pageSize}
        openDetail={openDetail}
        tr={tr}
      />

      {createDialogOpen && (
        <ResourceYamlCreateDialog
          title={tr('statefulsets.createTitle', 'Create StatefulSet from YAML')}
          initialYaml={initialYaml}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={async () => {
            await queryClient.invalidateQueries({ queryKey: listQueryKey })
          }}
        />
      )}
    </div>
  )
}
