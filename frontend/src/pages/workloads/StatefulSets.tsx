import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { CheckCircle, ChevronDown, Database, Plus, RefreshCw, Search } from 'lucide-react'
import { api, type StatefulSetInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'

export default function StatefulSets() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const { open: openDetail } = useResourceDetail()

  const [searchQuery, setSearchQuery] = useState('')
  const [selectedNamespace, setSelectedNamespace] = useState<string>('all')
  const [isNamespaceDropdownOpen, setIsNamespaceDropdownOpen] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(12)
  const namespaceDropdownRef = useRef<HTMLDivElement>(null)

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    staleTime: 30000,
  })
  const canWrite = me?.role === 'admin' || me?.role === 'write'

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

  const formatAge = (iso?: string | null) => {
    if (!iso) return '-'
    const createdAt = new Date(iso)
    const createdMs = createdAt.getTime()
    if (Number.isNaN(createdMs)) return '-'
    const diffSec = Math.max(0, Math.floor((Date.now() - createdMs) / 1000))
    const days = Math.floor(diffSec / 86400)
    const hours = Math.floor((diffSec % 86400) / 3600)
    const minutes = Math.floor((diffSec % 3600) / 60)
    if (days > 0) return `${days}d ${hours}h`
    if (hours > 0) return `${hours}h ${minutes}m`
    return `${minutes}m`
  }

  const getStatusColor = (status?: string | null) => {
    const s = String(status || '').toLowerCase()
    if (s.includes('healthy')) return 'badge-success'
    if (s.includes('degraded') || s.includes('idle')) return 'badge-warning'
    if (s.includes('unavailable') || s.includes('error') || s.includes('failed')) return 'badge-error'
    return 'badge-info'
  }

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
    let degraded = 0
    let unavailable = 0
    for (const item of items) {
      const s = String(item.status || '').toLowerCase()
      if (s.includes('healthy')) healthy += 1
      else if (s.includes('unavailable')) unavailable += 1
      else degraded += 1
    }
    return { total, healthy, degraded, unavailable }
  }, [filtered])

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace, pageSize])
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const paged = useMemo(() => {
    const start = (currentPage - 1) * pageSize
    return filtered.slice(start, start + pageSize)
  }, [filtered, currentPage, pageSize])

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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
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

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
        <div className="xl:col-span-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder={tr('statefulsets.searchPlaceholder', 'Search StatefulSets by name...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            />
          </div>
        </div>

        <div className="relative" ref={namespaceDropdownRef}>
          <button
            type="button"
            onClick={() => setIsNamespaceDropdownOpen((v) => !v)}
            className="h-12 w-full px-3 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent flex items-center justify-between gap-2"
          >
            <span className="text-sm font-medium">
              {selectedNamespace === 'all' ? tr('statefulsets.allNamespaces', 'All namespaces') : selectedNamespace}
            </span>
            <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${isNamespaceDropdownOpen ? 'rotate-180' : ''}`} />
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
                  {tr('statefulsets.allNamespaces', 'All namespaces')}
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

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-xs text-slate-400">{tr('statefulsets.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-xs text-emerald-300">{tr('statefulsets.stats.healthy', 'Healthy')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.healthy}</p>
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

      <div className="card overflow-x-auto">
        <table className="w-full text-sm min-w-[980px] table-fixed">
          <thead className="text-slate-400">
            <tr>
              {showNamespaceColumn && <th className="text-left py-3 px-4 w-[15%]">{tr('statefulsets.table.namespace', 'Namespace')}</th>}
              <th className="text-left py-3 px-4 w-[20%]">{tr('statefulsets.table.name', 'Name')}</th>
              <th className="text-left py-3 px-4 w-[10%]">{tr('statefulsets.table.ready', 'Ready')}</th>
              <th className="text-left py-3 px-4 w-[11%]">{tr('statefulsets.table.upToDate', 'Up to date')}</th>
              <th className="text-left py-3 px-4 w-[11%]">{tr('statefulsets.table.available', 'Available')}</th>
              <th className="text-left py-3 px-4 w-[10%]">{tr('statefulsets.table.status', 'Status')}</th>
              <th className="text-left py-3 px-4 w-[10%]">{tr('statefulsets.table.age', 'Age')}</th>
              <th className="text-left py-3 px-4 w-[13%]">{tr('statefulsets.table.service', 'Service')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {paged.map((sts: StatefulSetInfo) => (
              <tr
                key={`${sts.namespace}/${sts.name}`}
                className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                onClick={() => openDetail({ kind: 'StatefulSet', name: sts.name, namespace: sts.namespace })}
              >
                {showNamespaceColumn && <td className="py-3 px-4 font-mono text-xs truncate">{sts.namespace}</td>}
                <td className="py-3 px-4 font-medium text-white">
                  <div className="flex items-center gap-2">
                    <Database className="w-4 h-4 text-primary-400 flex-shrink-0" />
                    <span className="truncate">{sts.name}</span>
                  </div>
                </td>
                <td className="py-3 px-4">{`${sts.ready_replicas ?? 0}/${sts.replicas ?? 0}`}</td>
                <td className="py-3 px-4">{`${sts.updated_replicas ?? sts.current_replicas ?? 0}/${sts.replicas ?? 0}`}</td>
                <td className="py-3 px-4">{sts.available_replicas ?? 0}</td>
                <td className="py-3 px-4">
                  <span className={`badge ${getStatusColor(sts.status)}`}>{sts.status || '-'}</span>
                </td>
                <td className="py-3 px-4 font-mono text-xs">{formatAge(sts.created_at)}</td>
                <td className="py-3 px-4 text-xs font-mono truncate">{sts.service_name || '-'}</td>
              </tr>
            ))}
            {!isLoading && paged.length === 0 && (
              <tr>
                <td colSpan={showNamespaceColumn ? 8 : 7} className="py-6 px-4 text-slate-400">
                  {tr('statefulsets.noResults', 'No StatefulSets found.')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>
          {filtered.length === 0
            ? tr('statefulsets.paging.empty', '0 items')
            : tr('statefulsets.paging.range', '{{from}}-{{to}} / {{total}}', {
                from: (currentPage - 1) * pageSize + 1,
                to: Math.min(currentPage * pageSize, filtered.length),
                total: filtered.length,
              })}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage <= 1}
            className="px-2 py-1 rounded border border-slate-700 disabled:opacity-40"
          >
            {tr('statefulsets.paging.prev', 'Prev')}
          </button>
          <span>{currentPage} / {totalPages}</span>
          <button
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage >= totalPages}
            className="px-2 py-1 rounded border border-slate-700 disabled:opacity-40"
          >
            {tr('statefulsets.paging.next', 'Next')}
          </button>
        </div>
      </div>

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
