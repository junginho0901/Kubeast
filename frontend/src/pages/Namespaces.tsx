import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { ChevronDown, ChevronUp, RefreshCw, Search, Boxes, Plus } from 'lucide-react'
import { ModalOverlay } from '@/components/ModalOverlay'
import { useResourceDetail } from '@/components/ResourceDetailContext'

/* ──────────── types ──────────── */
interface NamespaceInfo {
  name: string
  status: string
  created_at: string
  labels: Record<string, string>
  resource_count: Record<string, number>
}

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

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    staleTime: 30000,
  })

  const isAdmin = me?.role === 'admin'

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
    <div className="space-y-6">
      {/* header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('namespaces.title', 'Namespaces')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('namespaces.subtitle', 'Review all namespaces in the cluster and manage resources')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && (
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
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
        <input
          type="text"
          placeholder={tr('namespaces.searchPlaceholder', 'Search namespaces...')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-10 pr-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
        />
      </div>

      {/* table */}
      <div className="card overflow-x-auto">
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
            {sortedNamespaces.map((ns) => {
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
                    <div className="flex flex-wrap gap-1 max-w-full overflow-hidden">
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
                        <span className="text-slate-500">+{labelEntries.length - 2}</span>
                      )}
                </div>
                  </td>
                  <td className="py-3 px-4 text-xs font-mono">
                    <span className="block truncate">{formatRelative(ns.created_at)}</span>
                  </td>
                </tr>
              )
            })}
            {sortedNamespaces.length === 0 && !isLoadingNs && (
              <tr>
                <td colSpan={4} className="py-6 px-4 text-slate-400">
                  {searchQuery
                    ? tr('namespaces.noSearchResults', 'No results found')
                    : tr('namespaces.empty', 'No namespaces found')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
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
