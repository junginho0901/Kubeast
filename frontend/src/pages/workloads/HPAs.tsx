import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type HPAInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveRowsPerPage } from '@/hooks/useAdaptiveRowsPerPage'
import { CheckCircle, ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'

type SortKey = null | 'name' | 'target' | 'minReplicas' | 'maxReplicas' | 'currentReplicas' | 'desiredReplicas' | 'age'

function parseAgeSeconds(createdAt?: string | null): number {
  if (!createdAt) return 0
  const ms = new Date(createdAt).getTime()
  if (!Number.isFinite(ms)) return 0
  return Math.max(0, Math.floor((Date.now() - ms) / 1000))
}

function formatAge(createdAt?: string | null): string {
  const sec = parseAgeSeconds(createdAt)
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function normalizeWatchHPAObject(obj: any): HPAInfo {
  if (typeof obj?.name === 'string' && typeof obj?.namespace === 'string' && typeof obj?.max_replicas === 'number') {
    return obj as HPAInfo
  }
  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}
  const scaleTargetRef = spec?.scaleTargetRef ?? {}

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    target_ref: `${scaleTargetRef?.kind ?? ''}/${scaleTargetRef?.name ?? ''}`,
    min_replicas: spec?.minReplicas ?? null,
    max_replicas: spec?.maxReplicas ?? 0,
    current_replicas: status?.currentReplicas ?? null,
    desired_replicas: status?.desiredReplicas ?? null,
    metrics: [],
    conditions: [],
    last_scale_time: status?.lastScaleTime ?? null,
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
  }
}

function applyHPAWatchEvent(
  prev: HPAInfo[] | undefined,
  event: { type?: string; object?: any },
): HPAInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchHPAObject(obj)
  const name = normalized?.name
  const namespace = normalized?.namespace
  if (!name || !namespace) return items

  const key = `${namespace}/${name}`
  const index = items.findIndex((item) => `${item.namespace}/${item.name}` === key)

  if (event.type === 'DELETED') {
    if (index >= 0) items.splice(index, 1)
    return items
  }

  if (index >= 0) items[index] = normalized
  else items.push(normalized)

  return items
}

function hpaToRawJson(hpa: HPAInfo): Record<string, unknown> {
  return {
    apiVersion: 'autoscaling/v2',
    kind: 'HorizontalPodAutoscaler',
    metadata: {
      name: hpa.name,
      namespace: hpa.namespace,
      creationTimestamp: hpa.created_at,
    },
    spec: {
      minReplicas: hpa.min_replicas,
      maxReplicas: hpa.max_replicas,
    },
    status: {
      currentReplicas: hpa.current_replicas,
      desiredReplicas: hpa.desired_replicas,
    },
  }
}

export default function HPAs() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const { open: openDetail } = useResourceDetail()

  const [searchQuery, setSearchQuery] = useState('')
  const [selectedNamespace, setSelectedNamespace] = useState<string>('all')
  const [isNamespaceDropdownOpen, setIsNamespaceDropdownOpen] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [currentPage, setCurrentPage] = useState(1)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const namespaceDropdownRef = useRef<HTMLDivElement>(null)
  const tableContainerRef = useRef<HTMLDivElement>(null)

  const { data: namespaces } = useQuery({
    queryKey: ['namespaces'],
    queryFn: () => api.getNamespaces(),
    staleTime: 30000,
  })

  const { data: hpas, isLoading } = useQuery({
    queryKey: ['workloads', 'hpas', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllHPAs(false)
        : api.getHPAs(selectedNamespace, false)
    ),
  })

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    staleTime: 30000,
  })
  const canCreate = me?.role === 'admin' || me?.role === 'write'

  useKubeWatchList({
    enabled: true,
    queryKey: ['workloads', 'hpas', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/apis/autoscaling/v2/horizontalpodautoscalers'
      : `/apis/autoscaling/v2/namespaces/${selectedNamespace}/horizontalpodautoscalers`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyHPAWatchEvent(prev as HPAInfo[] | undefined, event),
  })

  useEffect(() => {
    if (!isNamespaceDropdownOpen) return
    const handleClickOutside = (event: MouseEvent) => {
      if (namespaceDropdownRef.current && !namespaceDropdownRef.current.contains(event.target as Node)) {
        setIsNamespaceDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isNamespaceDropdownOpen])

  const filteredHPAs = useMemo(() => {
    if (!Array.isArray(hpas)) return [] as HPAInfo[]
    if (!searchQuery.trim()) return hpas
    const q = searchQuery.toLowerCase()
    return hpas.filter((h) =>
      h.name.toLowerCase().includes(q) ||
      h.namespace.toLowerCase().includes(q) ||
      (h.target_ref || '').toLowerCase().includes(q),
    )
  }, [hpas, searchQuery])

  const summary = useMemo(() => {
    const total = filteredHPAs.length
    let active = 0
    let inactive = 0

    for (const h of filteredHPAs) {
      if ((h.current_replicas ?? 0) > 0) active += 1
      else inactive += 1
    }

    return { total, active, inactive }
  }, [filteredHPAs])

  const handleSort = (key: NonNullable<SortKey>) => {
    if (sortKey !== key) {
      setSortKey(key)
      setSortDir('asc')
      return
    }
    if (sortDir === 'asc') {
      setSortDir('desc')
      return
    }
    setSortKey(null)
  }

  const renderSortIcon = (key: NonNullable<SortKey>) => {
    if (sortKey !== key) return null
    return sortDir === 'asc'
      ? <ChevronUp className="w-3.5 h-3.5 text-slate-300" />
      : <ChevronDown className="w-3.5 h-3.5 text-slate-300" />
  }

  const sortedHPAs = useMemo(() => {
    if (!sortKey) return filteredHPAs
    const list = [...filteredHPAs]

    const getValue = (h: HPAInfo): string | number => {
      switch (sortKey) {
        case 'name': return h.name
        case 'target': return h.target_ref || ''
        case 'minReplicas': return h.min_replicas ?? 0
        case 'maxReplicas': return h.max_replicas
        case 'currentReplicas': return h.current_replicas ?? 0
        case 'desiredReplicas': return h.desired_replicas ?? 0
        case 'age': return parseAgeSeconds(h.created_at)
        default: return ''
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
  }, [filteredHPAs, sortDir, sortKey])

  const rowsPerPage = useAdaptiveRowsPerPage(tableContainerRef, {
    recalculationKey: sortedHPAs.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedHPAs.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const pagedHPAs = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedHPAs.slice(start, start + rowsPerPage)
  }, [sortedHPAs, currentPage, rowsPerPage])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllHPAs(true)
        : await api.getHPAs(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['workloads', 'hpas', selectedNamespace] })
      queryClient.setQueryData(['workloads', 'hpas', selectedNamespace], data)
    } catch (error) {
      console.error('HPAs refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createHPAYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: sample-hpa
  namespace: ${ns}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: sample-deployment
  minReplicas: 1
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 80
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('hpas.title', 'Horizontal Pod Autoscalers')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('hpas.subtitle', 'Manage horizontal pod autoscaling policies across namespaces.')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('hpas.create', 'Create HPA')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('hpas.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('hpas.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 shrink-0">
        <div className="xl:col-span-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder={tr('hpas.searchPlaceholder', 'Search HPAs by name...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            />
          </div>
        </div>

        <div className="relative" ref={namespaceDropdownRef}>
          <button
            type="button"
            onClick={() => setIsNamespaceDropdownOpen(!isNamespaceDropdownOpen)}
            className="h-12 w-full px-3 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent flex items-center justify-between gap-2"
          >
            <span className="text-sm font-medium">
              {selectedNamespace === 'all' ? tr('hpas.allNamespaces', 'All namespaces') : selectedNamespace}
            </span>
            <ChevronDown
              className={`w-4 h-4 text-slate-400 transition-transform ${isNamespaceDropdownOpen ? 'rotate-180' : ''}`}
            />
          </button>
          {isNamespaceDropdownOpen && (
            <div className="absolute top-full left-0 mt-2 w-full bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-[100] max-h-[240px] overflow-y-auto">
              <button
                type="button"
                onClick={() => {
                  setSelectedNamespace('all')
                  setIsNamespaceDropdownOpen(false)
                }}
                className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 first:rounded-t-lg"
              >
                {selectedNamespace === 'all' && <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />}
                <span className={selectedNamespace === 'all' ? 'font-medium' : ''}>
                  {tr('hpas.allNamespaces', 'All namespaces')}
                </span>
              </button>
              {(namespaces || []).map((ns) => (
                <button
                  key={ns.name}
                  type="button"
                  onClick={() => {
                    setSelectedNamespace(ns.name)
                    setIsNamespaceDropdownOpen(false)
                  }}
                  className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 last:rounded-b-lg"
                >
                  {selectedNamespace === ns.name && <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />}
                  <span className={selectedNamespace === ns.name ? 'font-medium' : ''}>{ns.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('hpas.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('hpas.stats.active', 'Active')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.active}</p>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('hpas.stats.inactive', 'Inactive')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.inactive}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('hpas.matchCount', '{{count}} HPA{{suffix}} match.', {
            count: filteredHPAs.length,
            suffix: filteredHPAs.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[1040px] table-fixed">
            <thead className="text-slate-400">
              <tr>
                {showNamespaceColumn && (
                  <th className="text-left py-3 px-4 w-[150px]">{tr('hpas.table.namespace', 'Namespace')}</th>
                )}
                <th className="text-left py-3 px-4 w-[250px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('hpas.table.name', 'Name')}{renderSortIcon('name')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[240px] cursor-pointer" onClick={() => handleSort('target')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('hpas.table.reference', 'Reference')}{renderSortIcon('target')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('minReplicas')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('hpas.table.min', 'Min')}{renderSortIcon('minReplicas')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('maxReplicas')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('hpas.table.max', 'Max')}{renderSortIcon('maxReplicas')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[150px] cursor-pointer" onClick={() => handleSort('currentReplicas')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('hpas.table.replicas', 'Replicas')}{renderSortIcon('currentReplicas')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[160px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('hpas.table.age', 'Age')}{renderSortIcon('age')}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedHPAs.map((h) => (
                <tr
                  key={`${h.namespace}/${h.name}`}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'HorizontalPodAutoscaler',
                    name: h.name,
                    namespace: h.namespace,
                    rawJson: hpaToRawJson(h),
                  })}
                >
                  {showNamespaceColumn && <td className="py-3 px-4 text-xs font-mono">{h.namespace}</td>}
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{h.name}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{h.target_ref || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{h.min_replicas ?? '-'}</td>
                  <td className="py-3 px-4 text-xs font-mono">{h.max_replicas}</td>
                  <td className="py-3 px-4 text-xs font-mono">{h.current_replicas ?? 0}/{h.desired_replicas ?? 0}</td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(h.created_at)}</td>
                </tr>
              ))}
              {sortedHPAs.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 8 : 7} className="py-6 px-4 text-center text-slate-400">
                    {tr('hpas.noResults', 'No HPAs found.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {sortedHPAs.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedHPAs.length),
                total: sortedHPAs.length,
              })}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
                disabled={currentPage <= 1}
                className="px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:text-white hover:border-slate-500"
              >
                {tr('common.prev', 'Prev')}
              </button>
              <span className="text-xs text-slate-300 min-w-[72px] text-center">
                {currentPage} / {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))}
                disabled={currentPage >= totalPages}
                className="px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:text-white hover:border-slate-500"
              >
                {tr('common.next', 'Next')}
              </button>
            </div>
          </div>
        )}
      </div>

      {createDialogOpen && (
        <ResourceYamlCreateDialog
          title={tr('hpas.createTitle', 'Create HPA from YAML')}
          initialYaml={createHPAYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['workloads', 'hpas'] })
          }}
        />
      )}
    </div>
  )
}
