import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { RefreshCw, Search, Plus } from 'lucide-react'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { usePermission } from '@/hooks/usePermission'
import {
  sortNamespaces,
  type NamespaceInfo,
  type SummaryCard,
  type SortKey,
  type SortDir,
} from './namespaces/namespaceHelpers'
import { useNamespacesAISnapshot } from './namespaces/useNamespacesAISnapshot'
import NamespaceCreateDialog from './namespaces/NamespaceCreateDialog'
import NamespaceTable from './namespaces/NamespaceTable'

export default function Namespaces() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const { open: openDetail } = useResourceDetail()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })

  const [searchQuery, setSearchQuery] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [currentPage, setCurrentPage] = useState(1)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)

  const { data: namespaces, isLoading: isLoadingNs } = useQuery({
    queryKey: ['namespaces'],
    queryFn: () => api.getNamespaces(),
    staleTime: 30000,
  })

  useKubeWatchList({
    enabled: true,
    queryKey: ['namespaces'],
    path: '/api/v1/namespaces',
    query: 'watch=1',
    onEvent: (event) => {
      const name = event?.object?.name || event?.object?.metadata?.name
      if (name) {
        queryClient.invalidateQueries({ queryKey: ['namespace-describe', name] })
      }
    },
  })

  const { has } = usePermission()
  const isWriteRole = has('resource.namespace.create')

  const handleSort = (key: NonNullable<SortKey>) => {
    if (key !== sortKey) {
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

  const filteredNamespaces = useMemo(() => {
    if (!Array.isArray(namespaces)) return [] as NamespaceInfo[]
    if (!searchQuery.trim()) return namespaces as NamespaceInfo[]
    const q = searchQuery.toLowerCase()
    return (namespaces as NamespaceInfo[]).filter((ns) => ns.name.toLowerCase().includes(q))
  }, [namespaces, searchQuery])

  const namespaceStats = useMemo(() => {
    const total = filteredNamespaces.length
    let active = 0
    let terminating = 0
    let withLabels = 0

    for (const ns of filteredNamespaces) {
      const status = String(ns.status || '').toLowerCase()
      if (status === 'active') active += 1
      if (status.includes('terminating')) terminating += 1
      if (Object.keys(ns.labels || {}).length > 0) withLabels += 1
    }

    return { total, active, terminating, withLabels }
  }, [filteredNamespaces])

  const summaryCards = useMemo<SummaryCard[]>(
    () => [
      [tr('namespaces.stats.total', 'Total'), namespaceStats.total, 'border-slate-700 bg-slate-900/50', 'text-slate-400'],
      [tr('namespaces.stats.active', 'Active'), namespaceStats.active, 'border-emerald-700/40 bg-emerald-900/10', 'text-emerald-300'],
      [tr('namespaces.stats.terminating', 'Terminating'), namespaceStats.terminating, 'border-amber-700/40 bg-amber-900/10', 'text-amber-300'],
      [tr('namespaces.stats.withLabels', 'With Labels'), namespaceStats.withLabels, 'border-cyan-700/40 bg-cyan-900/10', 'text-cyan-300'],
    ],
    [namespaceStats.active, namespaceStats.terminating, namespaceStats.total, namespaceStats.withLabels, tr],
  )

  const sortedNamespaces = useMemo(
    () => sortNamespaces(filteredNamespaces, sortKey, sortDir),
    [filteredNamespaces, sortKey, sortDir],
  )

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedNamespaces.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedNamespaces.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const pagedNamespaces = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedNamespaces.slice(start, start + rowsPerPage)
  }, [sortedNamespaces, currentPage, rowsPerPage])

  useNamespacesAISnapshot({
    namespaces: namespaces as NamespaceInfo[] | undefined,
    pagedNamespaces,
    sortedNamespacesCount: sortedNamespaces.length,
    currentPage,
    rowsPerPage,
    searchQuery,
  })

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      await queryClient.invalidateQueries({ queryKey: ['namespaces'] })
    } catch (error) {
      console.error('Namespaces refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('namespaces.title', 'Namespaces')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('namespaces.subtitle', 'Review all namespaces in the cluster and manage resources')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isWriteRole && (
            <button
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('namespaces.create.button', 'Create Namespace')}
            </button>
          )}
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('namespaces.refresh', 'Refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('namespaces.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="relative shrink-0">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
        <input
          type="text"
          placeholder={tr('namespaces.searchPlaceholder', 'Search namespaces...')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-10 pr-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
        />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
        {summaryCards.map(([label, value, boxClass, labelClass]) => (
          <div key={label} className={`rounded-lg border px-4 py-3 ${boxClass}`}>
            <p className={`text-[11px] sm:text-xs leading-4 whitespace-nowrap ${labelClass}`}>{label}</p>
            <p className="mt-1 text-lg font-semibold text-white">{value}</p>
          </div>
        ))}
      </div>

      <NamespaceTable
        pagedNamespaces={pagedNamespaces}
        sortedNamespacesCount={sortedNamespaces.length}
        isLoadingNs={isLoadingNs}
        searchQuery={searchQuery}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={handleSort}
        currentPage={currentPage}
        totalPages={totalPages}
        rowsPerPage={rowsPerPage}
        onPageChange={setCurrentPage}
        tableContainerRef={tableContainerRef}
        tableBodyRef={tableBodyRef}
        theadRef={theadRef}
        firstRowRef={firstRowRef}
        onRowClick={(name) => openDetail({ kind: 'Namespace', name })}
        tr={tr}
      />

      {createDialogOpen && (
        <NamespaceCreateDialog
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => queryClient.invalidateQueries({ queryKey: ['namespaces'] })}
          tr={tr}
        />
      )}
    </div>
  )
}
