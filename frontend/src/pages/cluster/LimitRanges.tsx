import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type LimitRangeInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveRowsPerPage } from '@/hooks/useAdaptiveRowsPerPage'
import { ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'

type SortKey = null | 'name' | 'namespace' | 'types' | 'age'

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

function getLimitTypes(lr: LimitRangeInfo): string {
  if (!Array.isArray(lr.limits) || lr.limits.length === 0) return '-'
  const types = [...new Set(lr.limits.map((l) => l.type).filter(Boolean))]
  return types.length > 0 ? types.join(', ') : '-'
}

function normalizeWatchLimitRangeObject(obj: any): LimitRangeInfo {
  if (typeof obj?.name === 'string' && typeof obj?.namespace === 'string' && typeof obj?.created_at === 'string') {
    return obj as LimitRangeInfo
  }
  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}

  const rawLimits: any[] = spec?.limits ?? obj?.limits ?? []
  const limits = rawLimits.map((l: any) => ({
    type: l?.type,
    default: l?.default,
    default_request: l?.defaultRequest ?? l?.default_request,
    max: l?.max,
    min: l?.min,
  }))

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    limits,
    labels: metadata?.labels ?? obj?.labels ?? {},
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
  }
}

function applyLimitRangeWatchEvent(
  prev: LimitRangeInfo[] | undefined,
  event: { type?: string; object?: any },
): LimitRangeInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchLimitRangeObject(obj)
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

function limitRangeToRawJson(lr: LimitRangeInfo): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'LimitRange',
    metadata: {
      name: lr.name,
      namespace: lr.namespace,
      labels: lr.labels || {},
      creationTimestamp: lr.created_at,
    },
    spec: {
      limits: (lr.limits || []).map((l) => ({
        type: l.type,
        default: l.default,
        defaultRequest: l.default_request,
        max: l.max,
        min: l.min,
      })),
    },
  }
}

export default function LimitRanges() {
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

  const { data: limitRanges, isLoading } = useQuery({
    queryKey: ['cluster', 'limitranges', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllLimitRanges()
        : api.getLimitRanges(selectedNamespace)
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
    queryKey: ['cluster', 'limitranges', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/api/v1/limitranges'
      : `/api/v1/namespaces/${selectedNamespace}/limitranges`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyLimitRangeWatchEvent(prev as LimitRangeInfo[] | undefined, event),
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

  const filteredLimitRanges = useMemo(() => {
    if (!Array.isArray(limitRanges)) return [] as LimitRangeInfo[]
    if (!searchQuery.trim()) return limitRanges
    const q = searchQuery.toLowerCase()
    return limitRanges.filter((lr) =>
      lr.name.toLowerCase().includes(q) ||
      lr.namespace.toLowerCase().includes(q),
    )
  }, [limitRanges, searchQuery])

  const summary = useMemo(() => {
    const total = filteredLimitRanges.length
    let containerLimits = 0
    let podLimits = 0
    for (const lr of filteredLimitRanges) {
      if (Array.isArray(lr.limits)) {
        if (lr.limits.some((l) => l.type === 'Container')) containerLimits += 1
        if (lr.limits.some((l) => l.type === 'Pod')) podLimits += 1
      }
    }
    return { total, containerLimits, podLimits }
  }, [filteredLimitRanges])

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

  const sortedLimitRanges = useMemo(() => {
    if (!sortKey) return filteredLimitRanges
    const list = [...filteredLimitRanges]

    const getValue = (lr: LimitRangeInfo): string | number => {
      switch (sortKey) {
        case 'name': return lr.name
        case 'namespace': return lr.namespace
        case 'types': return getLimitTypes(lr)
        case 'age': return parseAgeSeconds(lr.created_at)
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
  }, [filteredLimitRanges, sortDir, sortKey])

  const rowsPerPage = useAdaptiveRowsPerPage(tableContainerRef, {
    recalculationKey: sortedLimitRanges.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedLimitRanges.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const pagedLimitRanges = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedLimitRanges.slice(start, start + rowsPerPage)
  }, [sortedLimitRanges, currentPage, rowsPerPage])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllLimitRanges(true)
        : await api.getLimitRanges(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['cluster', 'limitranges', selectedNamespace] })
      queryClient.setQueryData(['cluster', 'limitranges', selectedNamespace], data)
    } catch (error) {
      console.error('LimitRanges refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createLimitRangeYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: v1
kind: LimitRange
metadata:
  name: sample-limitrange
  namespace: ${ns}
spec:
  limits:
  - type: Container
    default:
      cpu: 500m
      memory: 512Mi
    defaultRequest:
      cpu: 100m
      memory: 128Mi
    max:
      cpu: "2"
      memory: 2Gi
    min:
      cpu: 50m
      memory: 64Mi
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('limitRanges.title', 'Limit Ranges')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('limitRanges.subtitle', 'Manage limit ranges across namespaces.')}
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
              {tr('limitRanges.create', 'Create Limit Range')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('limitRanges.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('limitRanges.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 shrink-0">
        <div className="xl:col-span-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder={tr('limitRanges.searchPlaceholder', 'Search limit ranges by name or namespace...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            />
          </div>
        </div>
        <div ref={namespaceDropdownRef} className="relative">
          <button
            type="button"
            onClick={() => setIsNamespaceDropdownOpen((prev) => !prev)}
            className="h-12 w-full flex items-center justify-between px-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white"
          >
            <span className="truncate">
              {selectedNamespace === 'all'
                ? tr('limitRanges.allNamespaces', 'All Namespaces')
                : selectedNamespace}
            </span>
            <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
          </button>
          {isNamespaceDropdownOpen && (
            <div className="absolute z-20 mt-1 w-full max-h-64 overflow-y-auto rounded-lg bg-slate-800 border border-slate-600 shadow-xl">
              <button
                type="button"
                className={`w-full text-left px-4 py-2.5 text-sm hover:bg-slate-700 ${
                  selectedNamespace === 'all' ? 'text-primary-400 font-medium' : 'text-white'
                }`}
                onClick={() => { setSelectedNamespace('all'); setIsNamespaceDropdownOpen(false) }}
              >
                {tr('limitRanges.allNamespaces', 'All Namespaces')}
              </button>
              {(namespaces || []).map((ns: any) => (
                <button
                  key={ns.name}
                  type="button"
                  className={`w-full text-left px-4 py-2.5 text-sm hover:bg-slate-700 ${
                    selectedNamespace === ns.name ? 'text-primary-400 font-medium' : 'text-white'
                  }`}
                  onClick={() => { setSelectedNamespace(ns.name); setIsNamespaceDropdownOpen(false) }}
                >
                  {ns.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('limitRanges.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('limitRanges.stats.containerLimits', 'Container Limits')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.containerLimits}</p>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('limitRanges.stats.podLimits', 'Pod Limits')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.podLimits}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('limitRanges.matchCount', '{{count}} limit range{{suffix}} match.', {
            count: filteredLimitRanges.length,
            suffix: filteredLimitRanges.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[700px] table-fixed">
            <thead className="text-slate-400">
              <tr>
                <th className="text-left py-3 px-4 w-[250px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('limitRanges.table.name', 'Name')}{renderSortIcon('name')}
                  </span>
                </th>
                {showNamespaceColumn && (
                  <th className="text-left py-3 px-4 w-[150px] cursor-pointer" onClick={() => handleSort('namespace')}>
                    <span className="inline-flex items-center gap-1">
                      {tr('limitRanges.table.namespace', 'Namespace')}{renderSortIcon('namespace')}
                    </span>
                  </th>
                )}
                <th className="text-left py-3 px-4 w-[200px] cursor-pointer" onClick={() => handleSort('types')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('limitRanges.table.types', 'Types')}{renderSortIcon('types')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('limitRanges.table.age', 'Age')}{renderSortIcon('age')}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedLimitRanges.map((lr) => (
                <tr
                  key={`${lr.namespace}/${lr.name}`}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'LimitRange',
                    name: lr.name,
                    namespace: lr.namespace,
                    rawJson: limitRangeToRawJson(lr),
                  })}
                >
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{lr.name}</span></td>
                  {showNamespaceColumn && (
                    <td className="py-3 px-4 text-xs font-mono text-slate-400">{lr.namespace}</td>
                  )}
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{getLimitTypes(lr)}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(lr.created_at)}</td>
                </tr>
              ))}
              {sortedLimitRanges.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 4 : 3} className="py-6 px-4 text-center text-slate-400">
                    {tr('limitRanges.noResults', 'No limit ranges found.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {sortedLimitRanges.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedLimitRanges.length),
                total: sortedLimitRanges.length,
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
          title={tr('limitRanges.createTitle', 'Create Limit Range from YAML')}
          initialYaml={createLimitRangeYamlTemplate}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['cluster', 'limitranges'] })
          }}
        />
      )}
    </div>
  )
}
