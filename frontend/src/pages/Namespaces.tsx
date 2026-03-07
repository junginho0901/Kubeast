import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { ChevronDown, ChevronUp, RefreshCw, Search, X, Boxes, Plus, Trash2 } from 'lucide-react'
import { ModalOverlay } from '@/components/ModalOverlay'
import YamlEditor from '@/components/YamlEditor'

/* ──────────── types ──────────── */
interface NamespaceInfo {
  name: string
  status: string
  created_at: string
  labels: Record<string, string>
  resource_count: Record<string, number>
}

interface ResourceQuotaItem {
  name: string
  namespace: string
  created_at?: string
  spec_hard: Record<string, string>
  status_hard: Record<string, string>
  status_used: Record<string, string>
}

interface LimitRangeItem {
  name: string
  namespace: string
  created_at?: string
  limits: Array<{
    type?: string
    default: Record<string, string>
    default_request: Record<string, string>
    max: Record<string, string>
    min: Record<string, string>
  }>
}

/* ──────────── component ──────────── */
export default function Namespaces() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })

  /* state */
  const [searchQuery, setSearchQuery] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [selectedNs, setSelectedNs] = useState<string | null>(null)
  const [detailTab, setDetailTab] = useState<'info' | 'yaml'>('info')
  const [yamlRefreshNonce, setYamlRefreshNonce] = useState(0)
  const [isYamlDirty, setIsYamlDirty] = useState(false)
  const [applyToast, setApplyToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [sortKey, setSortKey] = useState<null | 'name' | 'status' | 'age'>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  /* create namespace dialog */
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [newNsName, setNewNsName] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  /* delete namespace dialog */
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  /* pod filter */
  const [podFilter, setPodFilter] = useState('')

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

  const {
    data: nsDescribe,
    isLoading: isLoadingDescribe,
    isError: isDescribeError,
  } = useQuery({
    queryKey: ['namespace-describe', selectedNs],
    queryFn: () => api.describeNamespace(selectedNs as string),
    enabled: Boolean(selectedNs),
  })

  const {
    data: nsYaml,
    isLoading: isYamlLoading,
    isFetching: isYamlFetching,
    isError: isYamlError,
  } = useQuery({
    queryKey: ['namespace-yaml', selectedNs, yamlRefreshNonce],
    queryFn: () => api.getNamespaceYaml(selectedNs as string, yamlRefreshNonce > 0),
    enabled: Boolean(selectedNs) && detailTab === 'yaml',
  })

  /* Resource Quotas */
  const { data: resourceQuotas } = useQuery({
    queryKey: ['namespace-rq', selectedNs],
    queryFn: () => api.getNamespaceResourceQuotas(selectedNs as string),
    enabled: Boolean(selectedNs) && detailTab === 'info',
  })

  /* Limit Ranges */
  const { data: limitRanges } = useQuery({
    queryKey: ['namespace-lr', selectedNs],
    queryFn: () => api.getNamespaceLimitRanges(selectedNs as string),
    enabled: Boolean(selectedNs) && detailTab === 'info',
  })

  /* Owned Pods */
  const { data: nsPods } = useQuery({
    queryKey: ['namespace-pods', selectedNs],
    queryFn: () => api.getNamespacePods(selectedNs as string),
    enabled: Boolean(selectedNs) && detailTab === 'info',
  })

  /* ── delete namespace mutation ── */
  const deleteNsMutation = useMutation({
    mutationFn: (name: string) => api.deleteNamespace(name),
    onSuccess: async (_data, deletedName) => {
      setDeleteDialogOpen(false)
      setDeleteTarget(null)
      if (selectedNs === deletedName) {
        setSelectedNs(null)
      }
      /* Immediately remove the deleted namespace from query cache
         instead of refetching (which may return stale Redis-cached data
         while K8s is still finalizing Terminating state). */
      queryClient.setQueryData(['namespaces'], (prev: any[] | undefined) =>
        Array.isArray(prev) ? prev.filter((ns: any) => ns.name !== deletedName) : prev
      )
    },
  })

  /* ── events watch for selected namespace ── */
  const nsEventQuery = selectedNs
    ? `watch=1&fieldSelector=${encodeURIComponent(
        `involvedObject.kind=Namespace,involvedObject.name=${selectedNs}`
      )}`
    : 'watch=1'

  const applyNsEvent = (prev: any[] | undefined, event: { type?: string; object?: any }) => {
    const items = Array.isArray(prev) ? [...prev] : []
    const obj = event?.object
    if (!obj) return items
    const key = `${obj?.reason || ''}:${obj?.message || ''}`
    const index = items.findIndex((item) => {
      const ik = `${item?.reason || ''}:${item?.message || ''}`
      return ik === key
    })
    if (event.type === 'DELETED') {
      if (index >= 0) items.splice(index, 1)
      return items
    }
    if (index >= 0) items[index] = obj
    else items.push(obj)
    return items
  }

  useKubeWatchList({
    enabled: Boolean(selectedNs),
    queryKey: ['namespace-events', selectedNs],
    path: '/api/v1/events',
    query: nsEventQuery,
    applyEvent: applyNsEvent,
    onEvent: (event) => {
      const name = event?.object?.involvedObject?.name
      if (name) {
        queryClient.invalidateQueries({ queryKey: ['namespace-describe', name] })
      }
    },
  })

  /* ── side effects ── */
  useEffect(() => {
    setIsYamlDirty(false)
    setApplyToast(null)
  }, [selectedNs])

  useEffect(() => {
    setDetailTab('info')
    setYamlRefreshNonce(0)
    setPodFilter('')
  }, [selectedNs])

  useEffect(() => {
    if (!applyToast) return
    const timer = setTimeout(() => setApplyToast(null), 2500)
    return () => clearTimeout(timer)
  }, [applyToast])

  /* ── helpers ── */
  const canEditYaml = me?.role === 'admin' || me?.role === 'write'
  const isAdmin = me?.role === 'admin'

  const formatTimestamp = (iso?: string | null) => {
    if (!iso) return '-'
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return '-'
    return date.toLocaleString()
  }

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

  const renderKeyValueList = (obj?: Record<string, string>) => {
    const entries = obj ? Object.entries(obj) : []
    if (entries.length === 0) {
      return <span className="text-slate-400">{tr('common.none', '(none)')}</span>
    }
    return (
      <div className="flex flex-wrap gap-2 text-xs text-slate-200">
        {entries.map(([key, value]) => (
          <span
            key={`${key}-${value}`}
            className="relative inline-flex items-center rounded-full border border-slate-700 bg-slate-800/80 px-2 py-1 max-w-full group"
          >
            <span className="font-mono text-slate-300 max-w-[160px] truncate">{key}</span>
            <span className="mx-1 text-slate-500">:</span>
            <span className="max-w-[260px] truncate">{value}</span>
            <span className="pointer-events-none absolute left-0 top-full mt-1 z-20 w-max max-w-[520px] rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-200 shadow-lg opacity-0 group-hover:opacity-100 transition-opacity">
              <span className="break-words">{`${key}: ${value}`}</span>
            </span>
          </span>
        ))}
      </div>
    )
  }

  const getStatusColor = (status: string) => {
    const lower = (status || '').toLowerCase()
    if (lower === 'active') return 'badge-success'
    if (lower === 'terminating') return 'badge-warning'
    return 'badge-info'
  }

  const getEventBadge = (type?: string | null) => {
    const tval = (type || '').toLowerCase()
    if (tval.includes('warning')) return 'badge-warning'
    if (tval.includes('error') || tval.includes('failed')) return 'badge-error'
    return 'badge-info'
  }

  const getPodStatusColor = (status: string) => {
    const s = (status || '').toLowerCase()
    if (s === 'running') return 'badge-success'
    if (s === 'succeeded' || s === 'completed') return 'badge-info'
    if (s === 'pending') return 'badge-warning'
    if (s === 'failed' || s === 'error' || s === 'crashloopbackoff') return 'badge-error'
    return 'badge-info'
  }

  const getConditionStatusBadge = (status?: string | null) => {
    if (status === 'True') return 'badge-success'
    if (status === 'False') return 'badge-error'
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

  /* sorted events */
  const sortedEvents = useMemo(() => {
    if (!nsDescribe?.events || !Array.isArray(nsDescribe.events)) return []
    const getTime = (e: (typeof nsDescribe.events)[number]) => {
      const ts = e.last_timestamp || e.first_timestamp
      if (!ts) return 0
      const d = new Date(ts).getTime()
      return Number.isFinite(d) ? d : 0
    }
    return [...nsDescribe.events].sort((a, b) => getTime(b) - getTime(a))
  }, [nsDescribe?.events])

  /* filtered pods */
  const filteredPods = useMemo(() => {
    if (!Array.isArray(nsPods)) return []
    if (!podFilter.trim()) return nsPods
    const q = podFilter.toLowerCase()
    return nsPods.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.status || '').toLowerCase().includes(q) ||
        (p.node || '').toLowerCase().includes(q)
    )
  }, [nsPods, podFilter])

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

  const confirmDiscardYaml = () => {
    if (!isYamlDirty) return true
    return window.confirm(
      tr('namespaces.detail.yaml.unsaved', 'You have unsaved YAML changes. Discard them?')
    )
  }

  const handleCloseDetail = () => {
    if (!confirmDiscardYaml()) return
    setSelectedNs(null)
    setIsYamlDirty(false)
  }

  const handleTabChange = (next: 'info' | 'yaml') => {
    if (detailTab === next) return
    if (detailTab === 'yaml' && !confirmDiscardYaml()) return
    setDetailTab(next)
  }

  const handleApplyYaml = async (nextValue: string) => {
    if (!selectedNs) return
    await api.applyNamespaceYaml(selectedNs, nextValue)
    setYamlRefreshNonce((prev) => prev + 1)
    await queryClient.invalidateQueries({ queryKey: ['namespace-describe', selectedNs] })
    await queryClient.invalidateQueries({ queryKey: ['namespaces'] })
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
                  className={`text-slate-200 hover:bg-slate-800/60 cursor-pointer ${
                    selectedNs === ns.name ? 'bg-slate-800/60' : ''
                  }`}
                  onClick={() => setSelectedNs(ns.name)}
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

      {/* ──── detail sliding panel ──── */}
      {selectedNs && (
        <ModalOverlay onClose={handleCloseDetail}>
          <div
            className="fixed inset-y-0 right-0 w-full max-w-[740px] bg-slate-900 border-l border-slate-700 shadow-2xl overflow-x-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative flex h-full flex-col">
              {/* header */}
              <div className="flex items-start justify-between px-5 py-4 border-b border-slate-700">
              <div>
                  <h2 className="text-lg font-semibold text-white">{selectedNs}</h2>
                <p className="text-xs text-slate-400">
                    {tr('namespaces.detail.subtitle', 'Details from kubectl describe namespace {{name}}', {
                      name: selectedNs,
                  })}
                </p>
                </div>
                <div className="flex items-center gap-2">
                  {isAdmin && (
                    <button
                      onClick={() => {
                        setDeleteTarget(selectedNs)
                        setDeleteDialogOpen(true)
                      }}
                      title={tr('namespaces.delete.button', 'Delete Namespace')}
                      className="text-slate-400 hover:text-red-400 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                  <button onClick={handleCloseDetail} className="text-slate-400 hover:text-white">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* tabs */}
              <div className="flex items-center gap-2 px-5 py-2 border-b border-slate-800 text-xs">
                <button
                  type="button"
                  onClick={() => handleTabChange('info')}
                  className={`px-3 py-1 rounded-md border ${
                    detailTab === 'info'
                      ? 'border-slate-500 bg-slate-800 text-white'
                      : 'border-slate-800 text-slate-400 hover:text-white'
                  }`}
                >
                  {tr('namespaces.detail.tabs.info', 'Info')}
                </button>
              <button
                  type="button"
                  onClick={() => handleTabChange('yaml')}
                  className={`px-3 py-1 rounded-md border ${
                    detailTab === 'yaml'
                      ? 'border-slate-500 bg-slate-800 text-white'
                      : 'border-slate-800 text-slate-400 hover:text-white'
                  }`}
                >
                  {tr('namespaces.detail.tabs.yaml', 'YAML')}
              </button>
            </div>

              {/* body */}
              <div className="flex-1 overflow-y-auto overflow-x-hidden p-5 space-y-6 text-sm">
                {detailTab === 'yaml' ? (
                  <YamlEditor
                    key={`${selectedNs || 'ns'}-${detailTab}`}
                    value={nsYaml?.yaml || ''}
                    canEdit={canEditYaml}
                    isLoading={isYamlLoading}
                    isRefreshing={isYamlFetching}
                    error={isYamlError ? tr('namespaces.detail.yaml.error', 'Failed to load YAML.') : null}
                    onRefresh={() => setYamlRefreshNonce((prev) => prev + 1)}
                    onApply={handleApplyYaml}
                    onApplySuccess={() =>
                      setApplyToast({
                        type: 'success',
                        message: tr('namespaces.detail.yaml.applied', 'Applied'),
                      })
                    }
                    onApplyError={(message) =>
                      setApplyToast({
                        type: 'error',
                        message: message || tr('namespaces.detail.yaml.error', 'Failed to load YAML.'),
                      })
                    }
                    onDirtyChange={setIsYamlDirty}
                    showInlineApplied={false}
                    toast={applyToast}
                    labels={{
                      title: tr('namespaces.detail.yaml.title', 'Namespace YAML'),
                      refresh: tr('namespaces.detail.yaml.refresh', 'Refresh'),
                      copy: tr('namespaces.detail.yaml.copy', 'Copy'),
                      edit: tr('namespaces.detail.yaml.edit', 'Edit'),
                      apply: tr('namespaces.detail.yaml.apply', 'Apply'),
                      applying: tr('namespaces.detail.yaml.applying', 'Applying...'),
                      cancel: tr('namespaces.detail.yaml.cancel', 'Cancel'),
                      loading: tr('namespaces.detail.yaml.loading', 'Loading YAML...'),
                      error: tr('namespaces.detail.yaml.error', 'Failed to load YAML.'),
                      readonly: tr('namespaces.detail.yaml.readonly', 'Read-only for non-admin users.'),
                      editHint: tr('namespaces.detail.yaml.editHint', 'Edit is available for admin users.'),
                      applied: tr('namespaces.detail.yaml.applied', 'Applied'),
                      refreshing: tr('namespaces.detail.yaml.refreshing', 'Refreshing...'),
                    }}
                  />
                ) : isLoadingDescribe ? (
                  <p className="text-slate-400">{tr('namespaces.detail.loading', 'Loading namespace details...')}</p>
                ) : isDescribeError ? (
                  <p className="text-red-400">{tr('namespaces.detail.error', 'Failed to load namespace details.')}</p>
                ) : nsDescribe ? (
                  <>
                    {/* summary badges */}
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                          nsDescribe.status === 'Active'
                            ? 'border-emerald-500/60 text-emerald-300'
                            : 'border-amber-500/60 text-amber-300'
                        }`}
                      >
                        {tr('namespaces.detail.status', 'Status')}: {nsDescribe.status || '-'}
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-full border border-slate-600 px-2 py-0.5 text-[11px] font-medium text-slate-300">
                        {tr('namespaces.detail.labels', 'Labels')}: {Object.keys(nsDescribe.labels || {}).length}
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-full border border-slate-600 px-2 py-0.5 text-[11px] font-medium text-slate-300">
                        {tr('namespaces.detail.annotations', 'Annotations')}: {Object.keys(nsDescribe.annotations || {}).length}
                      </span>
                    </div>

                    {/* basic info */}
                    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
                      <p className="text-xs text-slate-400 mb-2">{tr('namespaces.detail.basicInfo', 'Basic information')}</p>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs text-slate-200">
                        <div>{tr('namespaces.detail.name', 'Name')}: <span className="text-white font-medium">{nsDescribe.name}</span></div>
                        <div>{tr('namespaces.detail.status', 'Status')}: <span className="text-white font-medium">{nsDescribe.status || '-'}</span></div>
                        <div className="md:col-span-2">
                          {tr('namespaces.detail.createdAt', 'Created')}: <span className="text-white font-medium">{formatTimestamp(nsDescribe.created_at)}</span>
                        </div>
                      </div>
                    </div>

                    {/* conditions */}
                    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
                      <p className="text-xs text-slate-400 mb-2">{tr('namespaces.detail.conditions', 'Conditions')}</p>
                      {nsDescribe.conditions && nsDescribe.conditions.length > 0 ? (
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs table-fixed min-w-[580px]">
                            <thead className="text-slate-400">
                              <tr>
                                <th className="text-left py-2 w-[22%]">{tr('namespaces.detail.conditionsTable.type', 'Type')}</th>
                                <th className="text-left py-2 w-[10%]">{tr('namespaces.detail.conditionsTable.status', 'Status')}</th>
                                <th className="text-left py-2 w-[18%]">{tr('namespaces.detail.conditionsTable.reason', 'Reason')}</th>
                                <th className="text-left py-2 w-[35%]">{tr('namespaces.detail.conditionsTable.message', 'Message')}</th>
                                <th className="text-left py-2 w-[15%]">{tr('namespaces.detail.conditionsTable.lastTransition', 'Last Transition')}</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800">
                              {nsDescribe.conditions.map((cond, idx) => (
                                <tr key={`${cond.type}-${idx}`} className="text-slate-200">
                                  <td className="py-2 pr-2 font-medium">{cond.type || '-'}</td>
                                  <td className="py-2 pr-2">
                                    <span className={`badge ${getConditionStatusBadge(cond.status)}`}>{cond.status || '-'}</span>
                                  </td>
                                  <td className="py-2 pr-2 break-words whitespace-normal">{cond.reason || '-'}</td>
                                  <td className="py-2 pr-2 break-words whitespace-normal">{cond.message || '-'}</td>
                                  <td className="py-2 pr-2">{formatRelative(cond.last_transition_time)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <span className="text-slate-400">{tr('namespaces.detail.conditionsEmpty', 'No conditions.')}</span>
                      )}
                    </div>

                    {/* labels */}
                    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
                      <p className="text-xs text-slate-400 mb-2">{tr('namespaces.detail.labels', 'Labels')}</p>
                      {renderKeyValueList(nsDescribe.labels)}
                    </div>

                    {/* annotations */}
                    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
                      <p className="text-xs text-slate-400 mb-2">{tr('namespaces.detail.annotations', 'Annotations')}</p>
                      {renderKeyValueList(nsDescribe.annotations)}
                    </div>

                    {/* Resource Quotas */}
                    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
                      <p className="text-xs text-slate-400 mb-2">{tr('namespaces.detail.resourceQuotas', 'Resource Quotas')}</p>
                      {Array.isArray(resourceQuotas) && resourceQuotas.length > 0 ? (
                        <div className="space-y-3">
                          {(resourceQuotas as ResourceQuotaItem[]).map((rq) => (
                            <div key={rq.name} className="rounded border border-slate-800 p-3">
                              <p className="text-xs text-white font-medium mb-2">{rq.name}</p>
                              <div className="overflow-x-auto">
                                <table className="w-full text-xs table-fixed min-w-[360px]">
                                  <thead className="text-slate-400">
                                    <tr>
                                      <th className="text-left py-1 w-[40%]">{tr('namespaces.detail.resourceQuotaTable.resource', 'Resource')}</th>
                                      <th className="text-left py-1 w-[30%]">{tr('namespaces.detail.resourceQuotaTable.used', 'Used')}</th>
                                      <th className="text-left py-1 w-[30%]">{tr('namespaces.detail.resourceQuotaTable.hard', 'Hard')}</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-slate-800">
                                    {Object.keys({ ...rq.status_hard, ...rq.spec_hard }).map((res) => (
                                      <tr key={res} className="text-slate-200">
                                        <td className="py-1 pr-2 font-mono">{res}</td>
                                        <td className="py-1 pr-2">{rq.status_used?.[res] || '-'}</td>
                                        <td className="py-1 pr-2">{rq.status_hard?.[res] || rq.spec_hard?.[res] || '-'}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          ))}
                  </div>
                      ) : (
                        <span className="text-slate-400">{tr('namespaces.detail.resourceQuotasEmpty', 'No resource quotas.')}</span>
                      )}
                    </div>

                    {/* Limit Ranges */}
                    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
                      <p className="text-xs text-slate-400 mb-2">{tr('namespaces.detail.limitRanges', 'Limit Ranges')}</p>
                      {Array.isArray(limitRanges) && limitRanges.length > 0 ? (
                        <div className="space-y-3">
                          {(limitRanges as LimitRangeItem[]).map((lr) => (
                            <div key={lr.name} className="rounded border border-slate-800 p-3">
                              <p className="text-xs text-white font-medium mb-2">{lr.name}</p>
                              {lr.limits.map((lim, li) => (
                                <div key={`${lr.name}-${li}`} className="overflow-x-auto mb-2">
                                  <p className="text-[11px] text-slate-400 mb-1">{tr('namespaces.detail.limitRangeTable.type', 'Type')}: {lim.type || '-'}</p>
                                  <table className="w-full text-xs table-fixed min-w-[480px]">
                                    <thead className="text-slate-400">
                                      <tr>
                                        <th className="text-left py-1 w-[20%]">{tr('namespaces.detail.limitRangeTable.resource', 'Resource')}</th>
                                        <th className="text-left py-1 w-[20%]">{tr('namespaces.detail.limitRangeTable.min', 'Min')}</th>
                                        <th className="text-left py-1 w-[20%]">{tr('namespaces.detail.limitRangeTable.max', 'Max')}</th>
                                        <th className="text-left py-1 w-[20%]">{tr('namespaces.detail.limitRangeTable.default', 'Default')}</th>
                                        <th className="text-left py-1 w-[20%]">{tr('namespaces.detail.limitRangeTable.defaultRequest', 'Default Request')}</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-800">
                                      {Object.keys({ ...lim.min, ...lim.max, ...lim.default, ...lim.default_request }).map((res) => (
                                        <tr key={res} className="text-slate-200">
                                          <td className="py-1 pr-2 font-mono">{res}</td>
                                          <td className="py-1 pr-2">{lim.min?.[res] || '-'}</td>
                                          <td className="py-1 pr-2">{lim.max?.[res] || '-'}</td>
                                          <td className="py-1 pr-2">{lim.default?.[res] || '-'}</td>
                                          <td className="py-1 pr-2">{lim.default_request?.[res] || '-'}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              ))}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span className="text-slate-400">{tr('namespaces.detail.limitRangesEmpty', 'No limit ranges.')}</span>
                      )}
                    </div>

                    {/* Owned Pods */}
                    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-xs text-slate-400">
                          {tr('namespaces.detail.pods', 'Pods')}
                          {Array.isArray(nsPods) && <span className="ml-1 text-slate-500">({nsPods.length})</span>}
                        </p>
                        {Array.isArray(nsPods) && nsPods.length > 5 && (
                          <div className="relative">
                            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500" />
                            <input
                              type="text"
                              value={podFilter}
                              onChange={(e) => setPodFilter(e.target.value)}
                              placeholder="Filter..."
                              className="pl-6 pr-2 py-1 text-[11px] bg-slate-800 border border-slate-700 rounded text-white placeholder-slate-500 focus:outline-none w-36"
                            />
                          </div>
                        )}
                      </div>
                      {Array.isArray(nsPods) && nsPods.length > 0 ? (
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs table-fixed min-w-[620px]">
                            <thead className="text-slate-400">
                              <tr>
                                <th className="text-left py-2 w-[30%]">{tr('namespaces.detail.podsTable.name', 'Name')}</th>
                                <th className="text-left py-2 w-[12%]">{tr('namespaces.detail.podsTable.status', 'Status')}</th>
                                <th className="text-left py-2 w-[10%]">{tr('namespaces.detail.podsTable.ready', 'Ready')}</th>
                                <th className="text-left py-2 w-[10%]">{tr('namespaces.detail.podsTable.restarts', 'Restarts')}</th>
                                <th className="text-left py-2 w-[23%]">{tr('namespaces.detail.podsTable.node', 'Node')}</th>
                                <th className="text-left py-2 w-[15%]">{tr('namespaces.detail.podsTable.age', 'Age')}</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800">
                              {filteredPods.slice(0, 100).map((pod) => (
                                <tr key={pod.name} className="text-slate-200">
                                  <td className="py-2 pr-2">
                                    <span className="block truncate font-mono" title={pod.name}>{pod.name}</span>
                                  </td>
                                  <td className="py-2 pr-2">
                                    <span className={`badge ${getPodStatusColor(pod.status)}`}>{pod.status}</span>
                                  </td>
                                  <td className="py-2 pr-2">{pod.ready}</td>
                                  <td className="py-2 pr-2">{pod.restarts}</td>
                                  <td className="py-2 pr-2">
                                    <span className="block truncate" title={pod.node || '-'}>{pod.node || '-'}</span>
                                  </td>
                                  <td className="py-2 pr-2">{formatRelative(pod.created_at)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {filteredPods.length > 100 && (
                            <p className="text-[11px] text-slate-500 mt-1">
                              {filteredPods.length - 100} more pods not shown
                            </p>
                          )}
                  </div>
                      ) : (
                        <span className="text-slate-400">{tr('namespaces.detail.podsEmpty', 'No pods.')}</span>
                      )}
                    </div>

                    {/* events */}
                    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
                      <p className="text-xs text-slate-400 mb-2">{tr('namespaces.detail.events', 'Events')}</p>
                      {sortedEvents.length > 0 ? (
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs table-fixed min-w-[620px]">
                            <thead className="text-slate-400">
                              <tr>
                                <th className="text-left py-2 w-[12%]">{tr('namespaces.detail.events.type', 'Type')}</th>
                                <th className="text-left py-2 w-[18%]">{tr('namespaces.detail.events.reason', 'Reason')}</th>
                                <th className="text-left py-2 w-[44%]">{tr('namespaces.detail.events.message', 'Message')}</th>
                                <th className="text-left py-2 w-[14%]">{tr('namespaces.detail.events.lastSeen', 'Last Seen')}</th>
                                <th className="text-left py-2 w-[12%]">{tr('namespaces.detail.events.count', 'Count')}</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800">
                              {sortedEvents.slice(0, 50).map((event, idx) => (
                                <tr key={`${event.reason}-${idx}`} className="text-slate-200">
                                  <td className="py-2 pr-2">
                                    <span className={`badge ${getEventBadge(event.type)}`}>{event.type || '-'}</span>
                                  </td>
                                  <td className="py-2 pr-2 align-top">
                                    <span className="block break-words whitespace-normal">{event.reason || '-'}</span>
                                  </td>
                                  <td className="py-2 pr-2 align-top">
                                    <span className="block break-words whitespace-normal">{event.message || '-'}</span>
                                  </td>
                                  <td className="py-2 pr-2">{formatRelative(event.last_timestamp || event.first_timestamp)}</td>
                                  <td className="py-2 pr-2">{event.count ?? 1}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <span className="text-slate-400">{tr('common.none', '(none)')}</span>
                      )}
                    </div>
                </>
              ) : (
                  <p className="text-slate-400">{tr('namespaces.detail.notFound', 'Namespace details not found.')}</p>
              )}
              </div>
            </div>
          </div>
        </ModalOverlay>
      )}

      {/* ──── Delete Namespace Confirm Dialog ──── */}
      {deleteDialogOpen && deleteTarget && (
        <ModalOverlay onClose={() => setDeleteDialogOpen(false)}>
          <div
            className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-6 w-full max-w-md mx-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-white mb-2">
              {tr('namespaces.delete.title', 'Delete Namespace')}
            </h3>
            <p className="text-sm text-slate-300 mb-4">
              {tr(
                'namespaces.delete.confirm',
                'Are you sure you want to delete namespace "{{name}}"? This action cannot be undone and will remove all resources within the namespace.',
                { name: deleteTarget }
              )}
            </p>
            <p className="text-xs text-red-400 mb-4 p-2 bg-red-500/10 border border-red-500/20 rounded-lg">
              {tr(
                'namespaces.delete.warning',
                '⚠ All resources (Pods, Services, Deployments, etc.) in this namespace will be permanently deleted.'
              )}
            </p>
            {deleteNsMutation.isError && (
              <p className="text-sm text-red-400 mb-3">
                {tr('namespaces.delete.error', 'Failed to delete namespace.')}
                {' '}
                {(deleteNsMutation.error as Error)?.message || ''}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setDeleteDialogOpen(false)
                  setDeleteTarget(null)
                }}
                className="px-4 py-2 text-sm text-slate-300 hover:text-white border border-slate-600 rounded-lg hover:bg-slate-800"
              >
                {tr('namespaces.delete.cancel', 'Cancel')}
              </button>
              <button
                onClick={() => deleteNsMutation.mutate(deleteTarget)}
                disabled={deleteNsMutation.isPending}
                className="px-4 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {deleteNsMutation.isPending ? (
                  <>
                    <RefreshCw className="w-3 h-3 animate-spin" />
                    {tr('namespaces.delete.deleting', 'Deleting...')}
                  </>
                ) : (
                  <>
                    <Trash2 className="w-3 h-3" />
                    {tr('namespaces.delete.submit', 'Delete')}
                  </>
                )}
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}
    </div>
  )
}
