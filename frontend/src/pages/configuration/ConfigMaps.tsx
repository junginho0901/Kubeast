import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type ConfigMapInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveRowsPerPage } from '@/hooks/useAdaptiveRowsPerPage'
import { CheckCircle, ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'

type SortKey = null | 'name' | 'namespace' | 'dataCount' | 'age'
type SummaryCard = [label: string, value: number, boxClass: string, labelClass: string]

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

function normalizeWatchConfigMapObject(obj: any): ConfigMapInfo {
  if (
    typeof obj?.name === 'string' &&
    typeof obj?.namespace === 'string' &&
    typeof obj?.data_count === 'number'
  ) {
    return obj as ConfigMapInfo
  }

  const metadata = obj?.metadata ?? {}
  const data = obj?.data ?? {}

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    data_count: typeof obj?.data_count === 'number' ? obj.data_count : Object.keys(data).length,
    data_keys: obj?.data_keys ?? Object.keys(data),
    binary_keys: obj?.binary_keys ?? [],
    labels: metadata?.labels ?? obj?.labels ?? null,
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
  }
}

function applyConfigMapWatchEvent(
  prev: ConfigMapInfo[] | undefined,
  event: { type?: string; object?: any },
): ConfigMapInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchConfigMapObject(obj)
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

export default function ConfigMaps() {
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

  const { data: configMaps, isLoading } = useQuery({
    queryKey: ['configuration', 'configmaps', selectedNamespace],
    queryFn: () =>
      selectedNamespace === 'all'
        ? api.getAllConfigMaps(false)
        : api.getConfigMaps(selectedNamespace, false),
  })

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    staleTime: 30000,
  })
  const canCreate = me?.role === 'admin' || me?.role === 'write'

  useKubeWatchList({
    enabled: true,
    queryKey: ['configuration', 'configmaps', selectedNamespace],
    path:
      selectedNamespace === 'all'
        ? '/api/v1/configmaps'
        : `/api/v1/namespaces/${selectedNamespace}/configmaps`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyConfigMapWatchEvent(prev as ConfigMapInfo[] | undefined, event),
    onEvent: (event) => {
      if (event?.type === 'DELETED') return
      const name = event?.object?.name || event?.object?.metadata?.name
      const ns = event?.object?.namespace || event?.object?.metadata?.namespace
      if (name && ns) {
        queryClient.invalidateQueries({ queryKey: ['configmap-describe', ns, name] })
      }
    },
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

  const filteredItems = useMemo(() => {
    if (!Array.isArray(configMaps)) return [] as ConfigMapInfo[]
    if (!searchQuery.trim()) return configMaps
    const q = searchQuery.toLowerCase()
    return configMaps.filter(
      (cm) =>
        cm.name.toLowerCase().includes(q) ||
        cm.namespace.toLowerCase().includes(q),
    )
  }, [configMaps, searchQuery])

  const summary = useMemo(() => {
    const total = filteredItems.length
    let totalKeys = 0
    for (const cm of filteredItems) totalKeys += cm.data_count
    return { total, totalKeys }
  }, [filteredItems])

  const summaryCards = useMemo<SummaryCard[]>(
    () => [
      [tr('configMapsPage.stats.total', 'Total'), summary.total, 'border-slate-700 bg-slate-900/50', 'text-slate-400'],
      [tr('configMapsPage.stats.totalKeys', 'Total Data Keys'), summary.totalKeys, 'border-cyan-700/40 bg-cyan-900/10', 'text-cyan-300'],
    ],
    [summary.total, summary.totalKeys, tr],
  )

  const handleSort = (key: NonNullable<SortKey>) => {
    if (sortKey !== key) { setSortKey(key); setSortDir('asc'); return }
    if (sortDir === 'asc') { setSortDir('desc'); return }
    setSortKey(null)
  }

  const renderSortIcon = (key: NonNullable<SortKey>) => {
    if (sortKey !== key) return null
    return sortDir === 'asc'
      ? <ChevronUp className="w-3.5 h-3.5 text-slate-300" />
      : <ChevronDown className="w-3.5 h-3.5 text-slate-300" />
  }

  const sortedItems = useMemo(() => {
    if (!sortKey) return filteredItems
    const list = [...filteredItems]
    const getValue = (cm: ConfigMapInfo): string | number => {
      switch (sortKey) {
        case 'name': return cm.name
        case 'namespace': return cm.namespace
        case 'dataCount': return cm.data_count
        case 'age': return parseAgeSeconds(cm.created_at)
        default: return ''
      }
    }
    list.sort((a, b) => {
      const av = getValue(a)
      const bv = getValue(b)
      if (typeof av === 'number' && typeof bv === 'number') return sortDir === 'asc' ? av - bv : bv - av
      return sortDir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av))
    })
    return list
  }, [filteredItems, sortDir, sortKey])

  const rowsPerPage = useAdaptiveRowsPerPage(tableContainerRef, { recalculationKey: sortedItems.length })
  const totalPages = Math.max(1, Math.ceil(sortedItems.length / rowsPerPage))

  useEffect(() => { setCurrentPage(1) }, [searchQuery, selectedNamespace])
  useEffect(() => { if (currentPage > totalPages) setCurrentPage(totalPages) }, [currentPage, totalPages])

  const pagedItems = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedItems.slice(start, start + rowsPerPage)
  }, [sortedItems, currentPage, rowsPerPage])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllConfigMaps(true)
        : await api.getConfigMaps(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['configuration', 'configmaps', selectedNamespace] })
      queryClient.setQueryData(['configuration', 'configmaps', selectedNamespace], data)
    } catch (error) {
      console.error('ConfigMaps refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: v1
kind: ConfigMap
metadata:
  name: sample-configmap
  namespace: ${ns}
data:
  key1: value1
  key2: value2
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('configMapsPage.title', 'ConfigMaps')}</h1>
          <p className="mt-2 text-slate-400">{tr('configMapsPage.subtitle', 'Manage ConfigMaps across namespaces.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button type="button" onClick={() => setCreateDialogOpen(true)} className="btn btn-primary flex items-center gap-2">
              <Plus className="w-4 h-4" />
              {tr('configMapsPage.create', 'Create ConfigMap')}
            </button>
          )}
          <button type="button" onClick={handleRefresh} disabled={isRefreshing} title={tr('configMapsPage.refreshTitle', 'Force refresh')} className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('configMapsPage.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 shrink-0">
        <div className="xl:col-span-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input type="text" placeholder={tr('configMapsPage.searchPlaceholder', 'Search by name or namespace...')} value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent" />
          </div>
        </div>
        <div className="relative" ref={namespaceDropdownRef}>
          <button type="button" onClick={() => setIsNamespaceDropdownOpen((v) => !v)} className="h-12 w-full px-3 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{selectedNamespace === 'all' ? tr('configMapsPage.allNamespaces', 'All namespaces') : selectedNamespace}</span>
            <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${isNamespaceDropdownOpen ? 'rotate-180' : ''}`} />
          </button>
          {isNamespaceDropdownOpen && (
            <div className="absolute top-full left-0 mt-2 w-full bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-[100] max-h-[240px] overflow-y-auto">
              <button type="button" onClick={() => { setSelectedNamespace('all'); setIsNamespaceDropdownOpen(false) }} className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 first:rounded-t-lg">
                {selectedNamespace === 'all' && <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />}
                <span className={selectedNamespace === 'all' ? 'font-medium' : ''}>{tr('configMapsPage.allNamespaces', 'All namespaces')}</span>
              </button>
              {(namespaces || []).map((ns) => (
                <button key={ns.name} type="button" onClick={() => { setSelectedNamespace(ns.name); setIsNamespaceDropdownOpen(false) }} className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 last:rounded-b-lg">
                  {selectedNamespace === ns.name && <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />}
                  <span className={selectedNamespace === ns.name ? 'font-medium' : ''}>{ns.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 shrink-0">
        {summaryCards.map(([label, value, boxClass, labelClass]) => (
          <div key={label} className={`rounded-lg border px-4 py-3 ${boxClass}`}>
            <p className={`text-[11px] sm:text-xs leading-4 whitespace-nowrap ${labelClass}`}>{label}</p>
            <p className="text-lg text-white font-semibold mt-1">{value}</p>
          </div>
        ))}
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('configMapsPage.matchCount', '{{count}} result(s) match.', { count: filteredItems.length })}
        </p>
      )}

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[700px] table-fixed">
            <thead className="text-slate-400">
              <tr>
                {showNamespaceColumn && (
                  <th className="text-left py-3 px-4 w-[200px] cursor-pointer" onClick={() => handleSort('namespace')}>
                    <span className="inline-flex items-center gap-1">{tr('configMapsPage.table.namespace', 'Namespace')}{renderSortIcon('namespace')}</span>
                  </th>
                )}
                <th className="text-left py-3 px-4 cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">{tr('configMapsPage.table.name', 'Name')}{renderSortIcon('name')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('dataCount')}>
                  <span className="inline-flex items-center gap-1">{tr('configMapsPage.table.data', 'Data')}{renderSortIcon('dataCount')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">{tr('configMapsPage.table.age', 'Age')}{renderSortIcon('age')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedItems.map((cm) => (
                <tr key={`${cm.namespace}/${cm.name}`} className="text-slate-200 hover:bg-slate-800/60 cursor-pointer" onClick={() => openDetail({ kind: 'ConfigMap', name: cm.name, namespace: cm.namespace })}>
                  {showNamespaceColumn && <td className="py-3 px-4 text-xs font-mono">{cm.namespace}</td>}
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{cm.name}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{cm.data_count}</td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(cm.created_at)}</td>
                </tr>
              ))}
              {sortedItems.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 4 : 3} className="py-6 px-4 text-center text-slate-400">
                    {tr('configMapsPage.noResults', 'No config maps found.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {sortedItems.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedItems.length),
                total: sortedItems.length,
              })}
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))} disabled={currentPage <= 1} className="px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:text-white hover:border-slate-500">
                {tr('common.prev', 'Prev')}
              </button>
              <span className="text-xs text-slate-300 min-w-[72px] text-center">{currentPage} / {totalPages}</span>
              <button type="button" onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))} disabled={currentPage >= totalPages} className="px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:text-white hover:border-slate-500">
                {tr('common.next', 'Next')}
              </button>
            </div>
          </div>
        )}
      </div>

      {createDialogOpen && (
        <ResourceYamlCreateDialog
          title={tr('configMapsPage.createTitle', 'Create ConfigMap from YAML')}
          initialYaml={createYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['configuration', 'configmaps'] })
          }}
        />
      )}
    </div>
  )
}
