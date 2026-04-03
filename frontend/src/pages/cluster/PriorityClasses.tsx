import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type PriorityClassInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveRowsPerPage } from '@/hooks/useAdaptiveRowsPerPage'
import { Loader2, ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'

type SortKey = null | 'name' | 'value' | 'globalDefault' | 'preemptionPolicy' | 'age'

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

function normalizeWatchPriorityClassObject(obj: any): PriorityClassInfo {
  if (typeof obj?.name === 'string' && typeof obj?.value === 'number' && typeof obj?.preemption_policy === 'string') {
    return obj as PriorityClassInfo
  }
  const metadata = obj?.metadata ?? {}

  return {
    name: metadata?.name ?? obj?.name ?? '',
    value: obj?.value ?? 0,
    global_default: obj?.globalDefault ?? false,
    preemption_policy: obj?.preemptionPolicy ?? 'PreemptLowerPriority',
    description: obj?.description ?? '',
    labels: metadata?.labels ?? obj?.labels ?? {},
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
  }
}

function applyPriorityClassWatchEvent(
  prev: PriorityClassInfo[] | undefined,
  event: { type?: string; object?: any },
): PriorityClassInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchPriorityClassObject(obj)
  const name = normalized?.name
  if (!name) return items

  const index = items.findIndex((item) => item.name === name)

  if (event.type === 'DELETED') {
    if (index >= 0) items.splice(index, 1)
    return items
  }

  if (index >= 0) items[index] = normalized
  else items.push(normalized)

  return items
}

function priorityClassToRawJson(pc: PriorityClassInfo): Record<string, unknown> {
  return {
    apiVersion: 'scheduling.k8s.io/v1',
    kind: 'PriorityClass',
    metadata: {
      name: pc.name,
      labels: pc.labels || {},
      creationTimestamp: pc.created_at,
    },
    value: pc.value,
    globalDefault: pc.global_default,
    preemptionPolicy: pc.preemption_policy,
    description: pc.description,
  }
}

export default function PriorityClasses() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const { open: openDetail } = useResourceDetail()

  const [searchQuery, setSearchQuery] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [currentPage, setCurrentPage] = useState(1)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const tableContainerRef = useRef<HTMLDivElement>(null)

  const { data: priorityClasses, isLoading } = useQuery({
    queryKey: ['cluster', 'priorityclasses'],
    queryFn: () => api.getPriorityClasses(false),
  })

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    staleTime: 30000,
  })
  const canCreate = me?.role === 'admin'

  useKubeWatchList({
    enabled: true,
    queryKey: ['cluster', 'priorityclasses'],
    path: '/apis/scheduling.k8s.io/v1/priorityclasses',
    query: 'watch=1',
    applyEvent: (prev, event) => applyPriorityClassWatchEvent(prev as PriorityClassInfo[] | undefined, event),
  })

  const filteredPCs = useMemo(() => {
    if (!Array.isArray(priorityClasses)) return [] as PriorityClassInfo[]
    if (!searchQuery.trim()) return priorityClasses
    const q = searchQuery.toLowerCase()
    return priorityClasses.filter((pc) =>
      pc.name.toLowerCase().includes(q) ||
      (pc.description || '').toLowerCase().includes(q) ||
      (pc.preemption_policy || '').toLowerCase().includes(q),
    )
  }, [priorityClasses, searchQuery])

  const summary = useMemo(() => {
    const total = filteredPCs.length
    let globalDefault = 0
    let preempting = 0

    for (const pc of filteredPCs) {
      if (pc.global_default) globalDefault += 1
      if (pc.preemption_policy === 'PreemptLowerPriority') preempting += 1
    }

    return { total, globalDefault, preempting }
  }, [filteredPCs])

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

  const sortedPCs = useMemo(() => {
    if (!sortKey) return filteredPCs
    const list = [...filteredPCs]

    const getValue = (pc: PriorityClassInfo): string | number => {
      switch (sortKey) {
        case 'name': return pc.name
        case 'value': return pc.value
        case 'globalDefault': return pc.global_default ? 1 : 0
        case 'preemptionPolicy': return pc.preemption_policy
        case 'age': return parseAgeSeconds(pc.created_at)
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
  }, [filteredPCs, sortDir, sortKey])

  const rowsPerPage = useAdaptiveRowsPerPage(tableContainerRef, {
    recalculationKey: sortedPCs.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedPCs.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const pagedPCs = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedPCs.slice(start, start + rowsPerPage)
  }, [sortedPCs, currentPage, rowsPerPage])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = await api.getPriorityClasses(true)
      queryClient.removeQueries({ queryKey: ['cluster', 'priorityclasses'] })
      queryClient.setQueryData(['cluster', 'priorityclasses'], data)
    } catch (error) {
      console.error('PriorityClasses refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createPCYamlTemplate = `apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: sample-priority-class
value: 1000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: "Sample priority class"
`

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('priorityClasses.title', 'Priority Classes')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('priorityClasses.subtitle', 'Manage pod scheduling priority across the cluster.')}
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
              {tr('priorityClasses.create', 'Create Priority Class')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('priorityClasses.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('priorityClasses.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="shrink-0">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input
            type="text"
            placeholder={tr('priorityClasses.searchPlaceholder', 'Search priority classes by name...')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('priorityClasses.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('priorityClasses.stats.globalDefault', 'Global Default')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.globalDefault}</p>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('priorityClasses.stats.preempting', 'Preempting')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.preempting}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('priorityClasses.matchCount', '{{count}} priority class{{suffix}} match.', {
            count: filteredPCs.length,
            suffix: filteredPCs.length === 1 ? '' : 'es',
          })}
        </p>
      )}

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[800px] table-fixed">
            <thead className="text-slate-400">
              <tr>
                <th className="text-left py-3 px-4 w-[250px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('priorityClasses.table.name', 'Name')}{renderSortIcon('name')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('value')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('priorityClasses.table.value', 'Value')}{renderSortIcon('value')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[130px] cursor-pointer" onClick={() => handleSort('globalDefault')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('priorityClasses.table.globalDefault', 'Global Default')}{renderSortIcon('globalDefault')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[180px] cursor-pointer" onClick={() => handleSort('preemptionPolicy')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('priorityClasses.table.preemptionPolicy', 'Preemption Policy')}{renderSortIcon('preemptionPolicy')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('priorityClasses.table.age', 'Age')}{renderSortIcon('age')}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedPCs.map((pc) => (
                <tr
                  key={pc.name}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'PriorityClass',
                    name: pc.name,
                    rawJson: priorityClassToRawJson(pc),
                  })}
                >
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{pc.name}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{pc.value}</td>
                  <td className="py-3 px-4">
                    {pc.global_default ? (
                      <span className="badge badge-success">True</span>
                    ) : (
                      <span className="text-xs text-slate-400">False</span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-xs font-mono">{pc.preemption_policy}</td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(pc.created_at)}</td>
                </tr>
              ))}
              {isLoading && (
                <tr>
                  <td colSpan={5} className="py-10 px-4 text-center text-slate-400">
                    <div className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading...
                    </div>
                  </td>
                </tr>
              )}

              {sortedPCs.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={5} className="py-6 px-4 text-center text-slate-400">
                    {tr('priorityClasses.noResults', 'No priority classes found.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {sortedPCs.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedPCs.length),
                total: sortedPCs.length,
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
          title={tr('priorityClasses.createTitle', 'Create Priority Class from YAML')}
          initialYaml={createPCYamlTemplate}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['cluster', 'priorityclasses'] })
          }}
        />
      )}
    </div>
  )
}
