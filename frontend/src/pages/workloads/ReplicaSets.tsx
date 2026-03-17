import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type ReplicaSetInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveRowsPerPage } from '@/hooks/useAdaptiveRowsPerPage'
import { CheckCircle, ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'

type SortKey =
  | null
  | 'name'
  | 'current'
  | 'desired'
  | 'ready'
  | 'available'
  | 'status'
  | 'containers'
  | 'images'
  | 'selector'
  | 'age'

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

function computeReplicaSetStatus(rs: {
  replicas: number
  ready_replicas: number
}): string {
  const desired = rs.replicas || 0
  const ready = rs.ready_replicas || 0
  if (desired === 0 && ready === 0) return 'Idle'
  if (desired > 0 && ready === 0) return 'Unavailable'
  if (ready !== desired) return 'Degraded'
  return 'Healthy'
}

function getReplicaSetStatusColor(status: string): string {
  const lower = String(status || '').toLowerCase()
  if (lower.includes('healthy')) return 'badge-success'
  if (lower.includes('degraded') || lower.includes('idle')) return 'badge-warning'
  if (lower.includes('unavailable') || lower.includes('error') || lower.includes('failed')) return 'badge-error'
  return 'badge-info'
}

function normalizeWatchReplicaSetObject(obj: any): ReplicaSetInfo {
  if (
    typeof obj?.name === 'string' &&
    typeof obj?.namespace === 'string' &&
    typeof obj?.replicas === 'number'
  ) {
    return {
      current_replicas: obj?.current_replicas ?? obj?.replicas ?? 0,
      ...obj,
    } as ReplicaSetInfo
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}
  const templateSpec = spec?.template?.spec ?? {}
  const containers = Array.isArray(templateSpec?.containers) ? templateSpec.containers : []

  const replicas = spec?.replicas ?? 0
  const currentReplicas = status?.replicas ?? 0
  const readyReplicas = status?.readyReplicas ?? 0
  const availableReplicas = status?.availableReplicas ?? 0

  const ownerReferences = Array.isArray(metadata?.ownerReferences) ? metadata.ownerReferences : []
  const owner = ownerReferences.length > 0 && ownerReferences[0]?.kind && ownerReferences[0]?.name
    ? `${ownerReferences[0].kind}/${ownerReferences[0].name}`
    : null

  const selector = spec?.selector?.matchLabels ?? {}
  const images = containers.map((container: any) => container?.image).filter(Boolean)
  const containerNames = containers.map((container: any) => container?.name).filter(Boolean)

  return {
    name: metadata?.name ?? obj?.name ?? '',
    namespace: metadata?.namespace ?? obj?.namespace ?? '',
    current_replicas: currentReplicas,
    replicas,
    ready_replicas: readyReplicas,
    available_replicas: availableReplicas,
    image: images[0] ?? '',
    images,
    container_names: containerNames,
    owner,
    labels: metadata?.labels ?? {},
    selector,
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
    status: computeReplicaSetStatus({ replicas, ready_replicas: readyReplicas }),
  }
}

function applyReplicaSetWatchEvent(
  prev: ReplicaSetInfo[] | undefined,
  event: { type?: string; object?: any },
): ReplicaSetInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchReplicaSetObject(obj)
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

function replicaSetToWorkloadRawJson(replicaset: ReplicaSetInfo): Record<string, unknown> {
  const labels = replicaset.selector || { app: replicaset.name }
  const containers = (replicaset.images || []).map((image, idx) => ({
    name: replicaset.container_names?.[idx] || `container-${idx + 1}`,
    image,
  }))

  return {
    apiVersion: 'apps/v1',
    kind: 'ReplicaSet',
    metadata: {
      name: replicaset.name,
      namespace: replicaset.namespace,
      labels: replicaset.labels || {},
      creationTimestamp: replicaset.created_at,
    },
    spec: {
      replicas: replicaset.replicas,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: { containers },
      },
    },
    status: {
      replicas: replicaset.current_replicas,
      readyReplicas: replicaset.ready_replicas,
      availableReplicas: replicaset.available_replicas,
    },
  }
}

export default function ReplicaSets() {
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

  const { data: replicasets, isLoading } = useQuery({
    queryKey: ['workloads', 'replicasets', selectedNamespace],
    queryFn: () => (
      selectedNamespace === 'all'
        ? api.getAllReplicaSets(false)
        : api.getReplicaSets(selectedNamespace, false)
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
    queryKey: ['workloads', 'replicasets', selectedNamespace],
    path: selectedNamespace === 'all'
      ? '/api/v1/replicasets'
      : `/api/v1/namespaces/${selectedNamespace}/replicasets`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyReplicaSetWatchEvent(prev as ReplicaSetInfo[] | undefined, event),
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

  const filteredReplicaSets = useMemo(() => {
    if (!Array.isArray(replicasets)) return [] as ReplicaSetInfo[]
    if (!searchQuery.trim()) return replicasets
    const q = searchQuery.toLowerCase()
    return replicasets.filter((rs) => {
      const imagesText = (rs.images || []).join(',')
      const containersText = (rs.container_names || []).join(',')
      const selectorText = Object.entries(rs.selector || {}).map(([k, v]) => `${k}=${v}`).join(',')
      return rs.name.toLowerCase().includes(q)
        || rs.namespace.toLowerCase().includes(q)
        || (rs.owner || '').toLowerCase().includes(q)
        || (rs.status || '').toLowerCase().includes(q)
        || imagesText.toLowerCase().includes(q)
        || containersText.toLowerCase().includes(q)
        || selectorText.toLowerCase().includes(q)
    })
  }, [replicasets, searchQuery])

  const summary = useMemo(() => {
    const total = filteredReplicaSets.length
    let healthy = 0
    let degraded = 0
    let unavailable = 0
    for (const rs of filteredReplicaSets) {
      const status = (rs.status || '').toLowerCase()
      if (status.includes('healthy')) healthy += 1
      else if (status.includes('unavailable')) unavailable += 1
      else degraded += 1
    }
    return { total, healthy, degraded, unavailable }
  }, [filteredReplicaSets])

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

  const sortedReplicaSets = useMemo(() => {
    if (!sortKey) return filteredReplicaSets
    const list = [...filteredReplicaSets]

    const getValue = (rs: ReplicaSetInfo): string | number => {
      switch (sortKey) {
        case 'name':
          return rs.name
        case 'current':
          return rs.current_replicas || 0
        case 'desired':
          return rs.replicas || 0
        case 'ready':
          return rs.ready_replicas || 0
        case 'available':
          return rs.available_replicas || 0
        case 'status':
          return rs.status || ''
        case 'containers':
          return (rs.container_names || []).join(',')
        case 'images':
          return (rs.images || []).join(',')
        case 'selector':
          return Object.entries(rs.selector || {}).map(([k, v]) => `${k}=${v}`).join(',')
        case 'age':
          return parseAgeSeconds(rs.created_at)
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
  }, [filteredReplicaSets, sortDir, sortKey])

  const rowsPerPage = useAdaptiveRowsPerPage(tableContainerRef, {
    recalculationKey: sortedReplicaSets.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedReplicaSets.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const pagedReplicaSets = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedReplicaSets.slice(start, start + rowsPerPage)
  }, [sortedReplicaSets, currentPage, rowsPerPage])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllReplicaSets(true)
        : await api.getReplicaSets(selectedNamespace, true)
      queryClient.removeQueries({ queryKey: ['workloads', 'replicasets', selectedNamespace] })
      queryClient.setQueryData(['workloads', 'replicasets', selectedNamespace], data)
    } catch (error) {
      console.error('ReplicaSets refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createReplicaSetYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: apps/v1
kind: ReplicaSet
metadata:
  name: sample-replicaset
  namespace: ${ns}
  labels:
    app: sample-replicaset
spec:
  replicas: 2
  selector:
    matchLabels:
      app: sample-replicaset
  template:
    metadata:
      labels:
        app: sample-replicaset
    spec:
      containers:
        - name: sample
          image: nginx:stable
          ports:
            - containerPort: 80
`
  }, [selectedNamespace])

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('replicasets.title', 'Replica Sets')}</h1>
          <p className="mt-2 text-slate-400">{tr('replicasets.subtitle', 'Inspect and manage ReplicaSets across namespaces.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('replicasets.create', 'Create ReplicaSet')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('replicasets.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('replicasets.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
        <div className="xl:col-span-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder={tr('replicasets.searchPlaceholder', 'Search replicasets by name...')}
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
              {selectedNamespace === 'all' ? tr('replicasets.allNamespaces', 'All namespaces') : selectedNamespace}
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
                  {tr('replicasets.allNamespaces', 'All namespaces')}
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
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('replicasets.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-emerald-300">{tr('replicasets.stats.healthy', 'Healthy')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.healthy}</p>
        </div>
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-amber-300">{tr('replicasets.stats.degraded', 'Degraded')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.degraded}</p>
        </div>
        <div className="rounded-lg border border-red-700/40 bg-red-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-red-300">{tr('replicasets.stats.unavailable', 'Unavailable')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.unavailable}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400">
          {tr('replicasets.matchCount', '{{count}} replicaset{{suffix}} match.', {
            count: filteredReplicaSets.length,
            suffix: filteredReplicaSets.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <div ref={tableContainerRef} className="card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[1480px] table-fixed">
            <thead className="text-slate-400">
              <tr>
                {showNamespaceColumn && <th className="text-left py-3 px-4 w-[140px]">{tr('replicasets.table.namespace', 'Namespace')}</th>}
                <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">{tr('replicasets.table.name', 'Name')}{renderSortIcon('name')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('current')}>
                  <span className="inline-flex items-center gap-1">{tr('replicasets.table.current', 'Current')}{renderSortIcon('current')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('desired')}>
                  <span className="inline-flex items-center gap-1">{tr('replicasets.table.desired', 'Desired')}{renderSortIcon('desired')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('ready')}>
                  <span className="inline-flex items-center gap-1">{tr('replicasets.table.ready', 'Ready')}{renderSortIcon('ready')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('available')}>
                  <span className="inline-flex items-center gap-1">{tr('replicasets.table.available', 'Available')}{renderSortIcon('available')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[130px] cursor-pointer" onClick={() => handleSort('status')}>
                  <span className="inline-flex items-center gap-1">{tr('replicasets.table.status', 'Status')}{renderSortIcon('status')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('containers')}>
                  <span className="inline-flex items-center gap-1">{tr('replicasets.table.containers', 'Containers')}{renderSortIcon('containers')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[230px] cursor-pointer" onClick={() => handleSort('images')}>
                  <span className="inline-flex items-center gap-1">{tr('replicasets.table.images', 'Images')}{renderSortIcon('images')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[180px] cursor-pointer" onClick={() => handleSort('selector')}>
                  <span className="inline-flex items-center gap-1">{tr('replicasets.table.selector', 'Selector')}{renderSortIcon('selector')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[160px]">{tr('replicasets.table.owner', 'Owner')}</th>
                <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">{tr('replicasets.table.age', 'Age')}{renderSortIcon('age')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedReplicaSets.map((rs) => (
                <tr
                  key={`${rs.namespace}/${rs.name}`}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'ReplicaSet',
                    name: rs.name,
                    namespace: rs.namespace,
                    rawJson: replicaSetToWorkloadRawJson(rs),
                  })}
                >
                  {showNamespaceColumn && <td className="py-3 px-4 text-xs font-mono">{rs.namespace}</td>}
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{rs.name}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{rs.current_replicas ?? 0}</td>
                  <td className="py-3 px-4 text-xs font-mono">{rs.replicas ?? 0}</td>
                  <td className="py-3 px-4 text-xs font-mono">{rs.ready_replicas ?? 0}</td>
                  <td className="py-3 px-4 text-xs font-mono">{rs.available_replicas ?? 0}</td>
                  <td className="py-3 px-4"><span className={`badge ${getReplicaSetStatusColor(rs.status)}`}>{rs.status || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{(rs.container_names || []).join(', ') || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{(rs.images || [rs.image]).filter(Boolean).join(', ') || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{Object.entries(rs.selector || {}).map(([k, v]) => `${k}=${v}`).join(', ') || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{rs.owner || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(rs.created_at)}</td>
                </tr>
              ))}
              {sortedReplicaSets.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 13 : 12} className="py-6 px-4 text-slate-400">
                    {tr('replicasets.noResults', 'No replicasets found.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {sortedReplicaSets.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedReplicaSets.length),
                total: sortedReplicaSets.length,
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
              <span className="text-xs text-slate-300 min-w-[72px] text-center">{currentPage} / {totalPages}</span>
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
          title={tr('replicasets.createTitle', 'Create ReplicaSet from YAML')}
          initialYaml={createReplicaSetYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['workloads', 'replicasets'] })
          }}
        />
      )}
    </div>
  )
}
