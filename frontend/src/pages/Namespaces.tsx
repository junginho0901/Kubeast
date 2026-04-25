import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { Loader2, ChevronDown, ChevronUp, RefreshCw, Search, Boxes, Plus } from 'lucide-react'
import { ModalOverlay } from '@/components/ModalOverlay'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { useAdaptiveRowsPerPage } from '@/hooks/useAdaptiveRowsPerPage'
import { useAIContext } from '@/hooks/useAIContext'
import { usePermission } from '@/hooks/usePermission'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'

/* ──────────── types ──────────── */
interface NamespaceInfo {
  name: string
  status: string
  created_at: string
  labels: Record<string, string>
  resource_count: Record<string, number>
}
type SummaryCard = [label: string, value: number, boxClass: string, labelClass: string]

/* ──────────── component ──────────── */
export default function Namespaces() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const { open: openDetail } = useResourceDetail()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })

  /* state */
  const [searchQuery, setSearchQuery] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [sortKey, setSortKey] = useState<null | 'name' | 'status' | 'age'>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [currentPage, setCurrentPage] = useState(1)
  const tableContainerRef = useRef<HTMLDivElement>(null)

  /* create namespace dialog */
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [newNsName, setNewNsName] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  /* ── data queries ── */
  const { data: namespaces, isLoading: isLoadingNs } = useQuery({
    queryKey: ['namespaces'],
    queryFn: () => api.getNamespaces(),
    staleTime: 30000,
  })

  /* WebSocket watch – real-time namespace list */
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

  /* ── helpers ── */
  const formatRelative = (iso?: string | null) => {
    if (!iso) return '-'
    const date = new Date(iso)
    const diffMs = Date.now() - date.getTime()
    if (!Number.isFinite(diffMs) || diffMs < 0) return '-'
    const minutes = Math.floor(diffMs / 60000)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)
    if (days >= 30) {
      const months = Math.floor(days / 30)
      return `${months}mo`
    }
    if (days > 0) return `${days}d`
    if (hours > 0) return `${hours}h`
    return `${minutes}m`
  }

  const parseCreatedDays = (createdAt?: string | null) => {
    if (!createdAt) return 0
    const date = new Date(createdAt)
    const diffMs = Date.now() - date.getTime()
    return Math.floor(diffMs / 86400000)
  }

  const getStatusColor = (status: string) => {
    const lower = (status || '').toLowerCase()
    if (lower === 'active') return 'badge-success'
    if (lower === 'terminating') return 'badge-warning'
    return 'badge-info'
  }

  /* namespace name validation */
  const nsNameRegex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
  const isValidNsName = (name: string) => {
    if (!name) return false
    if (name.length > 63) return false
    return nsNameRegex.test(name)
  }

  /* ── sorting ── */
  const handleSort = (key: typeof sortKey) => {
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

  const renderSortIcon = (key: NonNullable<typeof sortKey>) => {
    if (sortKey !== key) return null
    return sortDir === 'asc' ? (
      <ChevronUp className="w-3.5 h-3.5 text-slate-300" />
    ) : (
      <ChevronDown className="w-3.5 h-3.5 text-slate-300" />
    )
  }

  /* ── filtered & sorted list ── */
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

  const sortedNamespaces = useMemo(() => {
    if (!sortKey) return filteredNamespaces
    const list = [...filteredNamespaces]
    const getValue = (ns: NamespaceInfo) => {
      switch (sortKey) {
        case 'name':
          return ns.name
        case 'status':
          return ns.status || ''
        case 'age':
          return parseCreatedDays(ns.created_at)
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
      const as = String(av)
      const bs = String(bv)
      return sortDir === 'asc' ? as.localeCompare(bs) : bs.localeCompare(as)
    })
    return list
  }, [filteredNamespaces, sortDir, sortKey])

  const rowsPerPage = useAdaptiveRowsPerPage(tableContainerRef, {
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

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(namespaces) || namespaces.length === 0) return null
    const total = namespaces.length
    const inactive = (namespaces as NamespaceInfo[]).filter(
      (n) => !/active/i.test(n.status),
    ).length
    const prefix = inactive > 0 ? '⚠️ ' : ''
    return {
      source: 'base' as const,
      summary: `${prefix}Namespace ${total}개${inactive ? ` (Inactive ${inactive})` : ''}`,
      data: {
        filters: { search: searchQuery || undefined },
        stats: { total, inactive },
        ...summarizeList(pagedNamespaces as unknown as Record<string, unknown>[], {
          total: sortedNamespaces.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'status', 'age'],
          filterProblematic: (n) => !/active/i.test((n as unknown as NamespaceInfo).status),
          linkBuilder: (n) => {
            const ns = n as unknown as NamespaceInfo
            return buildResourceLink('Namespace', undefined, ns.name)
          },
        }),
      },
    }
  }, [namespaces, pagedNamespaces, sortedNamespaces.length, currentPage, rowsPerPage, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  /* ── handlers ── */
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

  const handleCreateNamespace = async () => {
    if (!isValidNsName(newNsName) || isCreating) return
    setIsCreating(true)
    setCreateError(null)
    try {
      await api.createNamespace(newNsName)
      setCreateDialogOpen(false)
      setNewNsName('')
      await queryClient.invalidateQueries({ queryKey: ['namespaces'] })
    } catch (err: any) {
      const detail = err?.response?.data?.detail || err?.message || ''
      if (detail.includes('already exists')) {
        setCreateError(tr('namespaces.create.exists', 'Namespace already exists.'))
      } else {
        setCreateError(tr('namespaces.create.error', 'Failed to create namespace.'))
      }
    } finally {
      setIsCreating(false)
    }
  }

  /* ──────────── RENDER ──────────── */
  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      {/* header */}
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
              onClick={() => {
                setCreateDialogOpen(true)
                setNewNsName('')
                setCreateError(null)
              }}
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

      {/* search */}
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

      {/* table */}
      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[700px] table-fixed">
            <thead className="text-slate-400">
              <tr>
                <th className="text-left py-3 px-4 w-[40%] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('namespaces.table.name', 'Name')}{renderSortIcon('name')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[15%] cursor-pointer" onClick={() => handleSort('status')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('namespaces.table.status', 'Status')}{renderSortIcon('status')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[30%]">
                  {tr('namespaces.table.labels', 'Labels')}
                </th>
                <th className="text-left py-3 px-4 w-[15%] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('namespaces.table.age', 'Age')}{renderSortIcon('age')}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedNamespaces.map((ns) => {
                const labelEntries = ns.labels ? Object.entries(ns.labels) : []
                return (
                  <tr
                    key={ns.name}
                    className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                    onClick={() => openDetail({ kind: 'Namespace', name: ns.name })}
                  >
                    <td className="py-3 px-4 font-medium text-white">
                      <div className="flex items-center gap-2">
                        <Boxes className="w-4 h-4 text-primary-400 flex-shrink-0" />
                        <span className="block truncate">{ns.name}</span>
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <span className={`badge ${getStatusColor(ns.status)}`}>{ns.status}</span>
                    </td>
                    <td className="py-3 px-4 text-xs">
                      <div className="flex flex-nowrap items-center gap-1 max-w-full overflow-hidden min-w-0 whitespace-nowrap">
                        {labelEntries.length > 0
                          ? labelEntries.slice(0, 2).map(([k, v]) => (
                              <span
                                key={k}
                                className="inline-block rounded-full border border-slate-700 bg-slate-800/80 px-2 py-0.5 text-slate-300 truncate max-w-[160px]"
                                title={`${k}: ${v}`}
                              >
                                {k}
                              </span>
                            ))
                          : <span className="text-slate-500">-</span>}
                        {labelEntries.length > 2 && (
                          <span className="text-slate-500 shrink-0">+{labelEntries.length - 2}</span>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-xs font-mono">
                      <span className="block truncate">{formatRelative(ns.created_at)}</span>
                    </td>
                  </tr>
                )
              })}
              {isLoadingNs && (
                <tr>
                  <td colSpan={4} className="py-10 px-4 text-center text-slate-400">
                    <div className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading...
                    </div>
                  </td>
                </tr>
              )}

              {sortedNamespaces.length === 0 && !isLoadingNs && (
                <tr>
                  <td colSpan={4} className="py-6 px-4 text-center text-slate-400">
                    {searchQuery
                      ? tr('namespaces.noSearchResults', 'No results found')
                      : tr('namespaces.empty', 'No namespaces found')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {sortedNamespaces.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedNamespaces.length),
                total: sortedNamespaces.length,
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

      {/* ──── Create Namespace Dialog ──── */}
      {createDialogOpen && (
        <ModalOverlay onClose={() => setCreateDialogOpen(false)}>
          <div
            className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-6 w-full max-w-md mx-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-white mb-4">
              {tr('namespaces.create.title', 'Create New Namespace')}
            </h3>
            <div className="space-y-3">
              <div>
                <input
                  type="text"
                  value={newNsName}
                  onChange={(e) => {
                    setNewNsName(e.target.value.toLowerCase())
                    setCreateError(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      handleCreateNamespace()
                    }
                  }}
                  placeholder={tr('namespaces.create.namePlaceholder', 'Enter namespace name')}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500"
                  autoFocus
                />
                <p className="mt-1 text-xs text-slate-400">
                  {tr('namespaces.create.nameHelp', 'Lowercase, numbers, and hyphens only (max 63 chars)')}
                </p>
                {newNsName && !isValidNsName(newNsName) && (
                  <p className="mt-1 text-xs text-red-400">
                    {newNsName.length > 63
                      ? tr('namespaces.create.nameTooLong', 'Name must be 63 characters or less.')
                      : tr('namespaces.create.nameInvalid', 'Invalid name.')}
                  </p>
                )}
                {createError && <p className="mt-1 text-xs text-red-400">{createError}</p>}
              </div>
              <div className="flex justify-end gap-2 pt-2">
              <button
                  onClick={() => setCreateDialogOpen(false)}
                  className="px-4 py-2 text-sm text-slate-300 hover:text-white border border-slate-600 rounded-lg hover:bg-slate-800"
              >
                  {tr('namespaces.create.cancel', 'Cancel')}
              </button>
              <button
                  onClick={handleCreateNamespace}
                  disabled={!isValidNsName(newNsName) || isCreating}
                  className="btn btn-primary px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isCreating
                    ? tr('namespaces.create.creating', 'Creating...')
                    : tr('namespaces.create.submit', 'Create')}
              </button>
            </div>
          </div>
          </div>
        </ModalOverlay>
        )}
    </div>
  )
}
