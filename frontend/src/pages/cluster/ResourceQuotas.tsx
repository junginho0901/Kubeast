import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type ResourceQuotaInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveRowsPerPage } from '@/hooks/useAdaptiveRowsPerPage'
import { Loader2, ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'

type SortKey = null | 'name' | 'namespace' | 'requests' | 'age'

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

function normalizeWatchResourceQuotaObject(obj: any): ResourceQuotaInfo {
  if (typeof obj?.name === 'string' && typeof obj?.namespace === 'string' && typeof obj?.created_at === 'string') {
    return obj as ResourceQuotaInfo
  }
  const metadata = obj?.metadata ?? {}
  const status = obj?.status ?? {}

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    status_hard: status?.hard ?? obj?.status_hard ?? {},
    status_used: status?.used ?? obj?.status_used ?? {},
    labels: metadata?.labels ?? obj?.labels ?? {},
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
  }
}

function applyResourceQuotaWatchEvent(
  prev: ResourceQuotaInfo[] | undefined,
  event: { type?: string; object?: any },
): ResourceQuotaInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchResourceQuotaObject(obj)
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

function resourceQuotaToRawJson(rq: ResourceQuotaInfo): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'ResourceQuota',
    metadata: {
      name: rq.name,
      namespace: rq.namespace,
      labels: rq.labels || {},
      creationTimestamp: rq.created_at,
    },
    status: {
      hard: rq.status_hard,
      used: rq.status_used,
    },
  }
}

export default function ResourceQuotas() {
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

  const { data: resourceQuotas, isLoading } = useQuery({
    queryKey: ['cluster', 'resourcequotas', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllResourceQuotas(false)
        : api.getResourceQuotas(selectedNamespace, false)
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
    queryKey: ['cluster', 'resourcequotas', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/api/v1/resourcequotas'
      : `/api/v1/namespaces/${selectedNamespace}/resourcequotas`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyResourceQuotaWatchEvent(prev as ResourceQuotaInfo[] | undefined, event),
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

  const filteredResourceQuotas = useMemo(() => {
    if (!Array.isArray(resourceQuotas)) return [] as ResourceQuotaInfo[]
    if (!searchQuery.trim()) return resourceQuotas
    const q = searchQuery.toLowerCase()
    return resourceQuotas.filter((rq) =>
      rq.name.toLowerCase().includes(q) ||
      rq.namespace.toLowerCase().includes(q),
    )
  }, [resourceQuotas, searchQuery])

  const summary = useMemo(() => {
    const total = filteredResourceQuotas.length
    let withCpu = 0
    let withMemory = 0
    for (const rq of filteredResourceQuotas) {
      const keys = Object.keys(rq.status_hard || {})
      if (keys.includes('cpu') || keys.includes('requests.cpu')) withCpu += 1
      if (keys.includes('memory') || keys.includes('requests.memory')) withMemory += 1
    }
    return { total, withCpu, withMemory }
  }, [filteredResourceQuotas])

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

  const sortedResourceQuotas = useMemo(() => {
    if (!sortKey) return filteredResourceQuotas
    const list = [...filteredResourceQuotas]

    const getValue = (rq: ResourceQuotaInfo): string | number => {
      switch (sortKey) {
        case 'name': return rq.name
        case 'namespace': return rq.namespace
        case 'requests': return Object.keys(rq.status_hard || {}).length
        case 'age': return parseAgeSeconds(rq.created_at)
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
  }, [filteredResourceQuotas, sortDir, sortKey])

  const rowsPerPage = useAdaptiveRowsPerPage(tableContainerRef, {
    recalculationKey: sortedResourceQuotas.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedResourceQuotas.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const pagedResourceQuotas = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedResourceQuotas.slice(start, start + rowsPerPage)
  }, [sortedResourceQuotas, currentPage, rowsPerPage])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllResourceQuotas(true)
        : await api.getResourceQuotas(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['cluster', 'resourcequotas', selectedNamespace] })
      queryClient.setQueryData(['cluster', 'resourcequotas', selectedNamespace], data)
    } catch (error) {
      console.error('ResourceQuotas refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createResourceQuotaYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: v1
kind: ResourceQuota
metadata:
  name: sample-quota
  namespace: ${ns}
spec:
  hard:
    pods: "10"
    requests.cpu: "4"
    requests.memory: 8Gi
    limits.cpu: "8"
    limits.memory: 16Gi
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('resourceQuotas.title', 'Resource Quotas')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('resourceQuotas.subtitle', 'Manage resource quotas across namespaces.')}
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
              {tr('resourceQuotas.create', 'Create Resource Quota')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('resourceQuotas.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('resourceQuotas.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 shrink-0">
        <div className="xl:col-span-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder={tr('resourceQuotas.searchPlaceholder', 'Search resource quotas by name or namespace...')}
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
                ? tr('resourceQuotas.allNamespaces', 'All Namespaces')
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
                {tr('resourceQuotas.allNamespaces', 'All Namespaces')}
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
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('resourceQuotas.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('resourceQuotas.stats.withCpu', 'With CPU Quotas')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.withCpu}</p>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('resourceQuotas.stats.withMemory', 'With Memory Quotas')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.withMemory}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('resourceQuotas.matchCount', '{{count}} resource quota{{suffix}} match.', {
            count: filteredResourceQuotas.length,
            suffix: filteredResourceQuotas.length === 1 ? '' : 's',
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
                    {tr('resourceQuotas.table.name', 'Name')}{renderSortIcon('name')}
                  </span>
                </th>
                {showNamespaceColumn && (
                  <th className="text-left py-3 px-4 w-[150px] cursor-pointer" onClick={() => handleSort('namespace')}>
                    <span className="inline-flex items-center gap-1">
                      {tr('resourceQuotas.table.namespace', 'Namespace')}{renderSortIcon('namespace')}
                    </span>
                  </th>
                )}
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('requests')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('resourceQuotas.table.requests', 'Request')}{renderSortIcon('requests')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('resourceQuotas.table.age', 'Age')}{renderSortIcon('age')}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedResourceQuotas.map((rq) => (
                <tr
                  key={`${rq.namespace}/${rq.name}`}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'ResourceQuota',
                    name: rq.name,
                    namespace: rq.namespace,
                    rawJson: resourceQuotaToRawJson(rq),
                  })}
                >
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{rq.name}</span></td>
                  {showNamespaceColumn && (
                    <td className="py-3 px-4 text-xs font-mono text-slate-400">{rq.namespace}</td>
                  )}
                  <td className="py-3 px-4 text-xs font-mono">{Object.keys(rq.status_hard || {}).length}</td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(rq.created_at)}</td>
                </tr>
              ))}
              {isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 4 : 3} className="py-10 px-4 text-center text-slate-400">
                    <div className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading...
                    </div>
                  </td>
                </tr>
              )}

              {sortedResourceQuotas.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 4 : 3} className="py-6 px-4 text-center text-slate-400">
                    {tr('resourceQuotas.noResults', 'No resource quotas found.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {sortedResourceQuotas.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedResourceQuotas.length),
                total: sortedResourceQuotas.length,
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
          title={tr('resourceQuotas.createTitle', 'Create Resource Quota from YAML')}
          initialYaml={createResourceQuotaYamlTemplate}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['cluster', 'resourcequotas'] })
          }}
        />
      )}
    </div>
  )
}
