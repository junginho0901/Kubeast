import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type DaemonSetInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveRowsPerPage } from '@/hooks/useAdaptiveRowsPerPage'
import { Loader2, CheckCircle, ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'

type SortKey = null | 'name' | 'ready' | 'current' | 'desired' | 'updated' | 'available' | 'status' | 'images' | 'age'

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

function computeDaemonSetStatus(daemonset: {
  desired: number
  ready: number
  misscheduled?: number
  unavailable?: number
}): string {
  const desired = daemonset.desired || 0
  const ready = daemonset.ready || 0
  const misscheduled = daemonset.misscheduled || 0
  const unavailable = daemonset.unavailable || 0

  if (desired === 0) return 'Idle'
  if (ready === 0) return 'Unavailable'
  if (ready !== desired || misscheduled > 0 || unavailable > 0) return 'Degraded'
  return 'Healthy'
}

function getDaemonSetStatusColor(status: string): string {
  const lower = String(status || '').toLowerCase()
  if (lower.includes('healthy')) return 'badge-success'
  if (lower.includes('degraded') || lower.includes('idle')) return 'badge-warning'
  if (lower.includes('unavailable') || lower.includes('error') || lower.includes('failed')) return 'badge-error'
  return 'badge-info'
}

function normalizeWatchDaemonSetObject(obj: any): DaemonSetInfo {
  if (
    typeof obj?.name === 'string' &&
    typeof obj?.namespace === 'string' &&
    typeof obj?.desired === 'number'
  ) {
    return obj as DaemonSetInfo
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}
  const templateSpec = spec?.template?.spec ?? {}

  const desired = status?.desiredNumberScheduled ?? status?.desired_number_scheduled ?? 0
  const current = status?.currentNumberScheduled ?? status?.current_number_scheduled ?? 0
  const ready = status?.numberReady ?? status?.number_ready ?? 0
  const updated = status?.updatedNumberScheduled ?? status?.updated_number_scheduled ?? 0
  const available = status?.numberAvailable ?? status?.number_available ?? 0
  const misscheduled = status?.numberMisscheduled ?? status?.number_misscheduled ?? 0
  const unavailable = status?.numberUnavailable ?? status?.number_unavailable ?? Math.max(desired - ready, 0)

  const images = Array.isArray(templateSpec?.containers)
    ? templateSpec.containers.map((container: any) => container?.image).filter(Boolean)
    : []

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    desired,
    current,
    ready,
    updated,
    available,
    misscheduled,
    unavailable,
    node_selector: templateSpec?.nodeSelector ?? obj?.node_selector ?? {},
    images,
    status: computeDaemonSetStatus({ desired, ready, misscheduled, unavailable }),
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
  }
}

function applyDaemonSetWatchEvent(
  prev: DaemonSetInfo[] | undefined,
  event: { type?: string; object?: any },
): DaemonSetInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchDaemonSetObject(obj)
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

function daemonSetToWorkloadRawJson(daemonset: DaemonSetInfo): Record<string, unknown> {
  return {
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: {
      name: daemonset.name,
      namespace: daemonset.namespace,
      creationTimestamp: daemonset.created_at,
    },
    spec: {
      selector: { matchLabels: { app: daemonset.name } },
      template: {
        metadata: { labels: { app: daemonset.name } },
        spec: {
          nodeSelector: daemonset.node_selector || {},
          containers: (daemonset.images || []).map((image, idx) => ({
            name: `container-${idx + 1}`,
            image,
          })),
        },
      },
      updateStrategy: {
        type: 'RollingUpdate',
      },
    },
    status: {
      desiredNumberScheduled: daemonset.desired,
      currentNumberScheduled: daemonset.current,
      numberReady: daemonset.ready,
      updatedNumberScheduled: daemonset.updated,
      numberAvailable: daemonset.available,
      numberMisscheduled: daemonset.misscheduled,
      numberUnavailable: daemonset.unavailable,
    },
  }
}

export default function DaemonSets() {
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

  const { data: daemonsets, isLoading } = useQuery({
    queryKey: ['workloads', 'daemonsets', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllDaemonSets(false)
        : api.getDaemonSets(selectedNamespace, false)
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
    queryKey: ['workloads', 'daemonsets', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/api/v1/daemonsets'
      : `/api/v1/namespaces/${selectedNamespace}/daemonsets`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyDaemonSetWatchEvent(prev as DaemonSetInfo[] | undefined, event),
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

  const filteredDaemonSets = useMemo(() => {
    if (!Array.isArray(daemonsets)) return [] as DaemonSetInfo[]
    if (!searchQuery.trim()) return daemonsets
    const q = searchQuery.toLowerCase()
    return daemonsets.filter((daemonset) => {
      const selectorText = Object.entries(daemonset.node_selector || {})
        .map(([key, value]) => `${key}=${value}`)
        .join(',')
      const imagesText = (daemonset.images || []).join(',')
      return daemonset.name.toLowerCase().includes(q)
        || daemonset.namespace.toLowerCase().includes(q)
        || String(daemonset.status || '').toLowerCase().includes(q)
        || selectorText.toLowerCase().includes(q)
        || imagesText.toLowerCase().includes(q)
    })
  }, [daemonsets, searchQuery])

  const summary = useMemo(() => {
    const total = filteredDaemonSets.length
    let healthy = 0
    let degraded = 0
    let unavailable = 0
    for (const daemonset of filteredDaemonSets) {
      const status = (daemonset.status || '').toLowerCase()
      if (status.includes('healthy')) healthy += 1
      else if (status.includes('unavailable')) unavailable += 1
      else degraded += 1
    }
    return { total, healthy, degraded, unavailable }
  }, [filteredDaemonSets])

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

  const sortedDaemonSets = useMemo(() => {
    if (!sortKey) return filteredDaemonSets
    const list = [...filteredDaemonSets]

    const getValue = (daemonset: DaemonSetInfo): string | number => {
      switch (sortKey) {
        case 'name':
          return daemonset.name
        case 'ready':
          return daemonset.desired === 0 ? 0 : (daemonset.ready || 0) / daemonset.desired
        case 'current':
          return daemonset.current || 0
        case 'desired':
          return daemonset.desired || 0
        case 'updated':
          return daemonset.updated || 0
        case 'available':
          return daemonset.available || 0
        case 'status':
          return daemonset.status || ''
        case 'images':
          return (daemonset.images || []).join(',')
        case 'age':
          return parseAgeSeconds(daemonset.created_at)
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
      return sortDir === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av))
    })

    return list
  }, [filteredDaemonSets, sortDir, sortKey])

  const rowsPerPage = useAdaptiveRowsPerPage(tableContainerRef, {
    recalculationKey: sortedDaemonSets.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedDaemonSets.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const pagedDaemonSets = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedDaemonSets.slice(start, start + rowsPerPage)
  }, [sortedDaemonSets, currentPage, rowsPerPage])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllDaemonSets(true)
        : await api.getDaemonSets(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['workloads', 'daemonsets', selectedNamespace] })
      queryClient.setQueryData(['workloads', 'daemonsets', selectedNamespace], data)
    } catch (error) {
      console.error('DaemonSets refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createDaemonSetYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: sample-daemonset
  namespace: ${ns}
  labels:
    app: sample-daemon
spec:
  selector:
    matchLabels:
      app: sample-daemon
  template:
    metadata:
      labels:
        app: sample-daemon
    spec:
      containers:
        - name: sample-daemon
          image: nginx:stable
          ports:
            - containerPort: 80
  updateStrategy:
    type: RollingUpdate
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('daemonsets.title', 'Daemon Sets')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('daemonsets.subtitle', 'Inspect scheduling health for DaemonSets across namespaces.')}
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
              {tr('daemonsets.create', 'Create DaemonSet')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('daemonsets.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('daemonsets.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 shrink-0">
        <div className="xl:col-span-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder={tr('daemonsets.searchPlaceholder', 'Search daemonsets by name...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            />
          </div>
        </div>

        <div className="relative" ref={namespaceDropdownRef}>
          <button
            type="button"
            onClick={() => setIsNamespaceDropdownOpen((value) => !value)}
            className="h-12 w-full px-3 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent flex items-center justify-between gap-2"
          >
            <span className="text-sm font-medium">
              {selectedNamespace === 'all' ? tr('daemonsets.allNamespaces', 'All namespaces') : selectedNamespace}
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
                  {tr('daemonsets.allNamespaces', 'All namespaces')}
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

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('daemonsets.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('daemonsets.stats.healthy', 'Healthy')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.healthy}</p>
        </div>
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-amber-300">{tr('daemonsets.stats.degraded', 'Degraded')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.degraded}</p>
        </div>
        <div className="rounded-lg border border-red-700/40 bg-red-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-red-300">{tr('daemonsets.stats.unavailable', 'Unavailable')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.unavailable}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('daemonsets.matchCount', '{{count}} daemonset{{suffix}} match.', {
            count: filteredDaemonSets.length,
            suffix: filteredDaemonSets.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[1320px] table-fixed">
            <thead className="text-slate-400">
              <tr>
                {showNamespaceColumn && (
                  <th className="text-left py-3 px-4 w-[140px]">{tr('daemonsets.table.namespace', 'Namespace')}</th>
                )}
                <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('daemonsets.table.name', 'Name')}{renderSortIcon('name')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('ready')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('daemonsets.table.ready', 'Ready')}{renderSortIcon('ready')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('current')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('daemonsets.table.current', 'Current')}{renderSortIcon('current')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('desired')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('daemonsets.table.desired', 'Desired')}{renderSortIcon('desired')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[95px] cursor-pointer" onClick={() => handleSort('updated')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('daemonsets.table.updated', 'Updated')}{renderSortIcon('updated')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('available')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('daemonsets.table.available', 'Available')}{renderSortIcon('available')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[130px] cursor-pointer" onClick={() => handleSort('status')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('daemonsets.table.status', 'Status')}{renderSortIcon('status')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[200px]">{tr('daemonsets.table.nodeSelector', 'Node Selector')}</th>
                <th className="text-left py-3 px-4 w-[230px] cursor-pointer" onClick={() => handleSort('images')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('daemonsets.table.images', 'Images')}{renderSortIcon('images')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('daemonsets.table.age', 'Age')}{renderSortIcon('age')}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedDaemonSets.map((daemonset) => (
                <tr
                  key={`${daemonset.namespace}/${daemonset.name}`}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'DaemonSet',
                    name: daemonset.name,
                    namespace: daemonset.namespace,
                    rawJson: daemonSetToWorkloadRawJson(daemonset),
                  })}
                >
                  {showNamespaceColumn && <td className="py-3 px-4 text-xs font-mono">{daemonset.namespace}</td>}
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{daemonset.name}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{daemonset.ready}/{daemonset.desired}</td>
                  <td className="py-3 px-4 text-xs font-mono">{daemonset.current}</td>
                  <td className="py-3 px-4 text-xs font-mono">{daemonset.desired}</td>
                  <td className="py-3 px-4 text-xs font-mono">{daemonset.updated}</td>
                  <td className="py-3 px-4 text-xs font-mono">{daemonset.available}</td>
                  <td className="py-3 px-4">
                    <span className={`badge ${getDaemonSetStatusColor(daemonset.status)}`}>{daemonset.status}</span>
                  </td>
                  <td className="py-3 px-4 text-xs font-mono">
                    <span className="block truncate">
                      {Object.entries(daemonset.node_selector || {}).map(([k, v]) => `${k}=${v}`).join(', ') || '-'}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{(daemonset.images || []).join(', ') || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(daemonset.created_at)}</td>
                </tr>
              ))}
              {isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 12 : 11} className="py-10 px-4 text-center text-slate-400">
                    <div className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading...
                    </div>
                  </td>
                </tr>
              )}

              {sortedDaemonSets.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 12 : 11} className="py-6 px-4 text-center text-slate-400">
                    {tr('daemonsets.noResults', 'No daemonsets found.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {sortedDaemonSets.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedDaemonSets.length),
                total: sortedDaemonSets.length,
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
          title={tr('daemonsets.createTitle', 'Create DaemonSet from YAML')}
          initialYaml={createDaemonSetYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['workloads', 'daemonsets'] })
          }}
        />
      )}
    </div>
  )
}
