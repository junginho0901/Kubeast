import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type PodInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveRowsPerPage } from '@/hooks/useAdaptiveRowsPerPage'
import { Loader2, CheckCircle, ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'

type SortKey = null | 'name' | 'ready' | 'status' | 'restarts' | 'pod_ip' | 'node_name' | 'age'
type SummaryCard = [label: string, value: number, boxClass: string, labelClass: string]

function parseReadyPair(ready?: string | null): [number, number] {
  if (!ready) return [0, 0]
  const m = String(ready).match(/^(\d+)\/(\d+)$/)
  if (!m) return [0, 0]
  return [Number(m[1]) || 0, Number(m[2]) || 0]
}

function parseAgeSeconds(createdAt?: string | null): number {
  if (!createdAt) return 0
  const ms = new Date(createdAt).getTime()
  if (!Number.isFinite(ms)) return 0
  return Math.max(0, Math.floor((Date.now() - ms) / 1000))
}

function formatAge(createdAt?: string | null): string {
  const diffSec = parseAgeSeconds(createdAt)
  const days = Math.floor(diffSec / 86400)
  const hours = Math.floor((diffSec % 86400) / 3600)
  const minutes = Math.floor((diffSec % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function pickPodDisplayStatus(pod: PodInfo): string {
  if (pod.status_reason) return String(pod.status_reason)

  const reasons: string[] = []
  for (const c of pod.containers || []) {
    const waitingReason = c?.state?.waiting?.reason
    if (waitingReason) reasons.push(String(waitingReason))
    const terminatedReason = c?.state?.terminated?.reason || c?.last_state?.terminated?.reason
    if (terminatedReason) reasons.push(String(terminatedReason))
  }
  if (reasons.length > 0) return reasons[0]

  const phase = pod.phase || pod.status || 'Unknown'
  if (phase === 'Running') {
    const [readyCount, total] = parseReadyPair(pod.ready)
    if (total > 0 && readyCount !== total) return 'NotReady'
  }
  return phase
}

function toSerializedContainerState(state: any): any {
  if (!state || typeof state !== 'object') return undefined
  const waiting = state.waiting
    ? {
        reason: state.waiting.reason ?? null,
        message: state.waiting.message ?? null,
      }
    : undefined
  const terminated = state.terminated
    ? {
        reason: state.terminated.reason ?? null,
        message: state.terminated.message ?? null,
        exit_code: state.terminated.exitCode ?? state.terminated.exit_code ?? null,
        signal: state.terminated.signal ?? null,
        started_at: state.terminated.startedAt ?? state.terminated.started_at ?? null,
        finished_at: state.terminated.finishedAt ?? state.terminated.finished_at ?? null,
      }
    : undefined
  const running = state.running
    ? {
        started_at: state.running.startedAt ?? state.running.started_at ?? null,
      }
    : undefined

  const result: Record<string, any> = {}
  if (waiting) result.waiting = waiting
  if (terminated) result.terminated = terminated
  if (running) result.running = running
  return Object.keys(result).length > 0 ? result : undefined
}

function normalizeWatchPodObject(obj: any): PodInfo {
  // already normalized (API list shape)
  if (typeof obj?.status === 'string' && typeof obj?.namespace === 'string' && typeof obj?.name === 'string') {
    return obj as PodInfo
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const status = obj?.status ?? {}
  const name = metadata?.name ?? obj?.name ?? ''
  const namespace = metadata?.namespace ?? obj?.namespace ?? ''

  const specContainers = Array.isArray(spec?.containers) ? spec.containers : []
  const specByName = new Map<string, { limits: any; requests: any; ports: any[] }>(
    specContainers.map((c: any) => [
      c?.name,
      {
        limits: c?.resources?.limits ?? null,
        requests: c?.resources?.requests ?? null,
        ports: Array.isArray(c?.ports)
          ? c.ports.map((p: any) => ({
              name: p?.name ?? null,
              container_port: p?.containerPort ?? p?.container_port ?? null,
              protocol: p?.protocol ?? null,
            }))
          : [],
      },
    ]),
  )

  const rawContainerStatuses = Array.isArray(status?.containerStatuses) ? status.containerStatuses : []
  const rawInitStatuses = Array.isArray(status?.initContainerStatuses) ? status.initContainerStatuses : []

  const mapStatus = (containerStatus: any) => {
    const ref: { limits: any; requests: any; ports: any[] } =
      specByName.get(containerStatus?.name) ?? { limits: null, requests: null, ports: [] }
    return {
      name: containerStatus?.name ?? '',
      image: containerStatus?.image ?? '',
      ready: Boolean(containerStatus?.ready),
      restart_count: containerStatus?.restartCount ?? containerStatus?.restart_count ?? 0,
      state: toSerializedContainerState(containerStatus?.state),
      last_state: toSerializedContainerState(containerStatus?.lastState ?? containerStatus?.last_state),
      limits: ref.limits,
      requests: ref.requests,
      ports: ref.ports,
    }
  }

  const containers = rawContainerStatuses.length > 0
    ? rawContainerStatuses.map(mapStatus)
    : (Array.isArray(obj?.containers) ? obj.containers : [])

  const init_containers = rawInitStatuses.length > 0
    ? rawInitStatuses.map(mapStatus)
    : (Array.isArray(obj?.init_containers) ? obj.init_containers : [])

  const readyContainers = containers.filter((c: any) => Boolean(c?.ready)).length
  const totalContainers = containers.length

  const phase = status?.phase ?? obj?.phase ?? (typeof obj?.status === 'string' ? obj.status : 'Unknown')
  const restartCount = containers.reduce((sum: number, c: any) => sum + (c?.restart_count ?? 0), 0)

  return {
    name,
    namespace,
    status: phase,
    phase,
    status_reason: status?.reason ?? obj?.status_reason ?? null,
    status_message: status?.message ?? obj?.status_message ?? null,
    node_name: spec?.nodeName ?? obj?.node_name ?? null,
    pod_ip: status?.podIP ?? obj?.pod_ip ?? null,
    containers,
    init_containers,
    labels: metadata?.labels ?? obj?.labels ?? {},
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? null,
    restart_count: restartCount,
    ready: totalContainers > 0 ? `${readyContainers}/${totalContainers}` : (obj?.ready ?? '0/0'),
  }
}

function applyPodWatchEvent(prev: PodInfo[] | undefined, event: { type?: string; object?: any }): PodInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchPodObject(obj)
  const name = normalized?.name
  const namespace = normalized?.namespace
  if (!name || !namespace) return items

  const key = `${namespace}/${name}`
  const index = items.findIndex((item) => `${item.namespace}/${item.name}` === key)

  if (event.type === 'DELETED') {
    if (index >= 0) items.splice(index, 1)
    return items
  }

  if (index >= 0) {
    items[index] = normalized
  } else {
    items.push(normalized)
  }
  return items
}

function getStatusColor(status: string): string {
  const lower = (status || '').toLowerCase()
  if (lower.includes('running') || lower.includes('succeeded') || lower.includes('completed')) return 'badge-success'
  if (lower.includes('pending') || lower.includes('init') || lower.includes('creating') || lower.includes('notready')) return 'badge-warning'
  if (
    lower.includes('error') ||
    lower.includes('failed') ||
    lower.includes('backoff') ||
    lower.includes('oomkilled') ||
    lower.includes('errimagepull')
  ) return 'badge-error'
  return 'badge-info'
}

export default function Pods() {
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

  const { data: pods, isLoading: isLoadingPods } = useQuery({
    queryKey: ['workloads', 'pods', selectedNamespace],
    queryFn: () => (selectedNamespace === 'all'
      ? api.getAllPods(false)
      : api.getPods(selectedNamespace, undefined, false)),
  })

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    staleTime: 30000,
  })
  const canCreate = me?.role === 'admin' || me?.role === 'write'

  useKubeWatchList({
    enabled: true,
    queryKey: ['workloads', 'pods', selectedNamespace],
    path: selectedNamespace === 'all' ? '/api/v1/pods' : `/api/v1/namespaces/${selectedNamespace}/pods`,
    query: 'watch=1',
    applyEvent: (prev, event) => applyPodWatchEvent(prev as PodInfo[] | undefined, event),
    onEvent: (event) => {
      if (event?.type === 'DELETED') return
      const obj = event?.object
      const name = obj?.name || obj?.metadata?.name
      const namespace = obj?.namespace || obj?.metadata?.namespace
      if (name && namespace) {
        queryClient.invalidateQueries({ queryKey: ['pod-describe', namespace, name] })
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
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isNamespaceDropdownOpen])

  const filteredPods = useMemo(() => {
    if (!Array.isArray(pods)) return [] as PodInfo[]
    if (!searchQuery.trim()) return pods
    const q = searchQuery.toLowerCase()
    return pods.filter((pod) =>
      pod.name.toLowerCase().includes(q) ||
      pod.namespace.toLowerCase().includes(q) ||
      (pod.node_name || '').toLowerCase().includes(q) ||
      (pod.pod_ip || '').toLowerCase().includes(q)
    )
  }, [pods, searchQuery])

  const podStats = useMemo(() => {
    const sourcePods = Array.isArray(pods) ? pods : []
    let total = sourcePods.length
    let ready = 0
    let notReady = 0
    let pending = 0
    let error = 0
    let restarting = 0
    const reasonMap = new Map<string, number>()

    for (const pod of sourcePods) {
      const phase = (pod.phase || pod.status || 'Unknown').toString()
      const statusText = pickPodDisplayStatus(pod)
      const [readyCount, totalCount] = parseReadyPair(pod.ready)

      if (phase === 'Pending') pending += 1
      if (pod.restart_count > 0) restarting += 1

      const isReadyRunning = phase === 'Running' && totalCount > 0 && readyCount === totalCount
      if (isReadyRunning) {
        ready += 1
      } else if (phase === 'Running') {
        notReady += 1
      }

      const lower = statusText.toLowerCase()
      const isError =
        phase === 'Failed' ||
        lower.includes('error') ||
        lower.includes('failed') ||
        lower.includes('backoff') ||
        lower.includes('errimagepull') ||
        lower.includes('oomkilled')
      if (isError) error += 1

      reasonMap.set(statusText, (reasonMap.get(statusText) || 0) + 1)
    }

    const topReasons = [...reasonMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)

    return { total, ready, notReady, pending, error, restarting, topReasons }
  }, [pods])

  const summaryCards = useMemo<SummaryCard[]>(
    () => [
      [tr('pods.stats.total', 'Total'), podStats.total, 'border-slate-700 bg-slate-900/50', 'text-slate-400'],
      [tr('pods.stats.ready', 'Ready'), podStats.ready, 'border-emerald-700/40 bg-emerald-900/10', 'text-emerald-300'],
      [tr('pods.stats.notReady', 'Not Ready'), podStats.notReady, 'border-amber-700/40 bg-amber-900/10', 'text-amber-300'],
      [tr('pods.stats.pending', 'Pending'), podStats.pending, 'border-yellow-700/40 bg-yellow-900/10', 'text-yellow-300'],
      [tr('pods.stats.error', 'Error'), podStats.error, 'border-rose-700/40 bg-rose-900/10', 'text-rose-300'],
      [tr('pods.stats.restarting', 'Restarting'), podStats.restarting, 'border-cyan-700/40 bg-cyan-900/10', 'text-cyan-300'],
    ],
    [podStats.error, podStats.notReady, podStats.pending, podStats.ready, podStats.restarting, podStats.total, tr],
  )

  const createPodYamlTemplate = useMemo(() => {
    const ns = selectedNamespace !== 'all' ? selectedNamespace : 'default'
    return `apiVersion: v1
kind: Pod
metadata:
  name: sample-pod
  namespace: ${ns}
  labels:
    app: sample
spec:
  containers:
    - name: sample
      image: nginx:stable
      ports:
        - containerPort: 80
`
  }, [selectedNamespace])

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

  const sortedPods = useMemo(() => {
    if (!sortKey) return filteredPods
    const list = [...filteredPods]

    const getValue = (pod: PodInfo): string | number => {
      switch (sortKey) {
        case 'name':
          return pod.name
        case 'ready': {
          const [readyCount, total] = parseReadyPair(pod.ready)
          return total === 0 ? 0 : readyCount / total
        }
        case 'status':
          return pickPodDisplayStatus(pod)
        case 'restarts':
          return pod.restart_count || 0
        case 'pod_ip':
          return pod.pod_ip || ''
        case 'node_name':
          return pod.node_name || ''
        case 'age':
          return parseAgeSeconds(pod.created_at)
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
  }, [filteredPods, sortDir, sortKey])

  const rowsPerPage = useAdaptiveRowsPerPage(tableContainerRef, {
    recalculationKey: sortedPods.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedPods.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, selectedNamespace])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const pagedPods = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedPods.slice(start, start + rowsPerPage)
  }, [sortedPods, currentPage, rowsPerPage])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await api.getAllPods(true)
        : await api.getPods(selectedNamespace, undefined, true)
      queryClient.removeQueries({ queryKey: ['workloads', 'pods', selectedNamespace] })
      queryClient.setQueryData(['workloads', 'pods', selectedNamespace], data)
    } catch (error) {
      console.error('Pods refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('pods.title', 'Pods')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('pods.subtitle', 'Inspect pod health and placement across namespaces.')}
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
              {tr('pods.create', 'Create Pod')}
            </button>
          )}
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('pods.forceRefreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('pods.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 shrink-0">
        <div className="xl:col-span-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder={tr('pods.searchPlaceholder', 'Search pods by name...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            />
          </div>
        </div>

        <div className="relative" ref={namespaceDropdownRef}>
          <button
            type="button"
            onClick={() => setIsNamespaceDropdownOpen(!isNamespaceDropdownOpen)}
            className="h-12 w-full px-3 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent flex items-center justify-between gap-2"
          >
            <span className="text-sm font-medium">
              {selectedNamespace === 'all' ? tr('pods.allNamespaces', 'All namespaces') : selectedNamespace}
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
                  {tr('pods.allNamespaces', 'All namespaces')}
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

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('pods.matchCount', '{{count}} pod{{suffix}} match.', {
            count: filteredPods.length,
            suffix: filteredPods.length === 1 ? '' : 's',
          })}
        </p>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 shrink-0">
        {summaryCards.map(([label, value, boxClass, labelColor]) => (
          <div key={label} className={`rounded-lg border px-3 py-2.5 ${boxClass}`}>
            <div className={`text-[11px] sm:text-xs leading-4 whitespace-nowrap ${labelColor}`}>{label}</div>
            <div className="mt-1 text-lg font-semibold text-white">{value}</div>
          </div>
        ))}
      </div>

      {podStats.topReasons.length > 0 && (
        <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3 shrink-0">
          <div className="text-xs text-slate-400 mb-2">Top status reasons</div>
          <div className="flex flex-wrap gap-2">
            {podStats.topReasons.map(([reason, count]) => (
              <span key={reason} className="badge badge-info font-mono">
                {reason}: {count}
              </span>
            ))}
          </div>
        </div>
      )}

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[980px] table-fixed">
            <thead className="text-slate-400">
              <tr>
                {showNamespaceColumn && (
                  <th className="text-left py-3 px-4 w-[140px]">
                    {tr('pods.table.namespace', 'Namespace')}
                  </th>
                )}
                <th className="text-left py-3 px-4 w-[260px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('pods.table.name', 'Name')}{renderSortIcon('name')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('ready')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('pods.table.ready', 'Ready')}{renderSortIcon('ready')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[180px] cursor-pointer" onClick={() => handleSort('status')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('pods.table.status', 'Status')}{renderSortIcon('status')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('restarts')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('pods.table.restarts', 'Restarts')}{renderSortIcon('restarts')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[140px] cursor-pointer" onClick={() => handleSort('pod_ip')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('pods.table.podIp', 'Pod IP')}{renderSortIcon('pod_ip')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[170px] cursor-pointer" onClick={() => handleSort('node_name')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('pods.table.node', 'Node')}{renderSortIcon('node_name')}
                  </span>
                </th>
                <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('pods.table.age', 'Age')}{renderSortIcon('age')}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedPods.map((pod) => {
                const displayStatus = pickPodDisplayStatus(pod)
                return (
                  <tr
                    key={`${pod.namespace}/${pod.name}`}
                    className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                    onClick={() => openDetail({
                      kind: 'Pod',
                      name: pod.name,
                      namespace: pod.namespace,
                      rawJson: pod as unknown as Record<string, unknown>,
                    })}
                  >
                    {showNamespaceColumn && <td className="py-3 px-4 text-xs font-mono">{pod.namespace}</td>}
                    <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{pod.name}</span></td>
                    <td className="py-3 px-4 text-xs font-mono">{pod.ready || '-'}</td>
                    <td className="py-3 px-4">
                      <span className={`badge ${getStatusColor(displayStatus)}`}>{displayStatus}</span>
                    </td>
                    <td className="py-3 px-4 text-xs font-mono">{pod.restart_count ?? 0}</td>
                    <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{pod.pod_ip || '-'}</span></td>
                    <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{pod.node_name || '-'}</span></td>
                    <td className="py-3 px-4 text-xs font-mono">{formatAge(pod.created_at)}</td>
                  </tr>
                )
              })}
              {isLoadingPods && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 8 : 7} className="py-10 px-4 text-center text-slate-400">
                    <div className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading...
                    </div>
                  </td>
                </tr>
              )}

              {sortedPods.length === 0 && !isLoadingPods && (
                <tr>
                  <td colSpan={showNamespaceColumn ? 8 : 7} className="py-6 px-4 text-center text-slate-400">
                    {tr('pods.noResults', 'No pods found.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {sortedPods.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedPods.length),
                total: sortedPods.length,
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
          title={tr('pods.createTitle', 'Create Pod from YAML')}
          initialYaml={createPodYamlTemplate}
          namespace={selectedNamespace !== 'all' ? selectedNamespace : undefined}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['workloads', 'pods'] })
          }}
        />
      )}
    </div>
  )
}
