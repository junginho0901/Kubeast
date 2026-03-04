import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Clock, Loader2, RefreshCw, Search, Server, X } from 'lucide-react'
import { ModalOverlay } from '@/components/ModalOverlay'
import YamlEditor from '@/components/YamlEditor'

interface NodeInfo {
  name: string
  status: string
  roles: string[]
  age: string
  version?: string | null
  internal_ip?: string | null
  external_ip?: string | null
}

interface NodeMetric {
  name: string
  cpu: string
  cpu_percent: string
  memory: string
  memory_percent: string
  timestamp?: string | null
  window?: string | null
}

interface NodeDescribe {
  name: string
  created_at?: string | null
  labels?: Record<string, string>
  annotations?: Record<string, string>
  conditions: Array<{
    type: string
    status: string
    reason?: string | null
    message?: string | null
    last_transition_time?: string | null
    last_update_time?: string | null
  }>
  pod_cidr?: string | null
  pod_cidrs?: string[] | null
  unschedulable?: boolean | null
  addresses: Array<{ type: string; address: string }>
  taints: Array<{ key?: string | null; value?: string | null; effect?: string | null }>
  system_info: {
    architecture?: string | null
    boot_id?: string | null
    machine_id?: string | null
    operating_system?: string | null
    os_image?: string | null
    kernel_version?: string | null
    container_runtime?: string | null
    kubelet_version?: string | null
    kube_proxy_version?: string | null
    system_uuid?: string | null
  }
}

interface NodeEvent {
  type?: string | null
  reason?: string | null
  message?: string | null
  count?: number | null
  first_timestamp?: string | null
  last_timestamp?: string | null
}

export default function ClusterNodes() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })

  const [searchQuery, setSearchQuery] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [selectedNodeName, setSelectedNodeName] = useState<string | null>(null)
  const [detailTab, setDetailTab] = useState<'info' | 'yaml'>('info')
  const [yamlRefreshNonce, setYamlRefreshNonce] = useState(0)
  const [drainDialogOpen, setDrainDialogOpen] = useState(false)
  const [drainId, setDrainId] = useState<string | null>(null)
  const [drainStatus, setDrainStatus] = useState<'idle' | 'pending' | 'draining' | 'success' | 'error'>('idle')
  const [drainError, setDrainError] = useState<string | null>(null)
  const [podFilter, setPodFilter] = useState('')
  const [podPage, setPodPage] = useState(1)
  const [sortKey, setSortKey] = useState<null | 'name' | 'status' | 'roles' | 'cpu' | 'memory' | 'version' | 'internal_ip' | 'external_ip' | 'age'>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  const { data: nodes, isLoading: isLoadingNodes } = useQuery({
    queryKey: ['cluster', 'nodes'],
    queryFn: () => api.getNodes(false),
  })

  const { data: metrics, isLoading: isLoadingMetrics, isError: isMetricsError } = useQuery({
    queryKey: ['cluster', 'node-metrics'],
    queryFn: () => api.getNodeMetrics(),
  })

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    staleTime: 30000,
  })

  const { data: nodeDescribe, isLoading: isLoadingDescribe, isError: isDescribeError } = useQuery({
    queryKey: ['cluster', 'nodes', 'describe', selectedNodeName],
    queryFn: () => api.describeNode(selectedNodeName as string),
    enabled: Boolean(selectedNodeName),
  })

  const {
    data: nodeYaml,
    isLoading: isYamlLoading,
    isFetching: isYamlFetching,
    isError: isYamlError,
  } = useQuery({
    queryKey: ['cluster', 'nodes', 'yaml', selectedNodeName, yamlRefreshNonce],
    queryFn: () =>
      api.getNodeYaml(selectedNodeName as string, yamlRefreshNonce > 0),
    enabled: Boolean(selectedNodeName) && detailTab === 'yaml',
  })

  const { data: nodePods } = useQuery({
    queryKey: ['cluster', 'nodes', 'pods', selectedNodeName],
    queryFn: () => api.getNodePods(selectedNodeName as string),
    enabled: Boolean(selectedNodeName),
  })

  const { data: nodeEvents } = useQuery({
    queryKey: ['cluster', 'nodes', 'events', selectedNodeName],
    queryFn: () => api.getNodeEvents(selectedNodeName as string),
    enabled: Boolean(selectedNodeName),
  })

  const { data: drainStatusData } = useQuery({
    queryKey: ['cluster', 'nodes', 'drain-status', drainId],
    queryFn: () => api.getNodeDrainStatus(selectedNodeName as string, drainId as string),
    enabled: Boolean(selectedNodeName && drainId),
    refetchInterval: drainId ? 1000 : false,
  })

  useEffect(() => {
    setDrainDialogOpen(false)
    setDrainId(null)
    setDrainStatus('idle')
    setDrainError(null)
  }, [selectedNodeName])

  const metricsMap = useMemo(() => {
    const map = new Map<string, NodeMetric>()
    if (Array.isArray(metrics)) {
      for (const metric of metrics) {
        map.set(metric.name, metric)
      }
    }
    return map
  }, [metrics])

  const canEditYaml = me?.role === 'admin'
  const isAdmin = me?.role === 'admin'

  const cordonMutation = useMutation({
    mutationFn: (nodeName: string) => api.cordonNode(nodeName),
    onSuccess: async (_data, nodeName) => {
      await queryClient.invalidateQueries({ queryKey: ['cluster', 'nodes'] })
      await queryClient.invalidateQueries({ queryKey: ['cluster', 'nodes', 'describe', nodeName] })
    },
  })

  const uncordonMutation = useMutation({
    mutationFn: (nodeName: string) => api.uncordonNode(nodeName),
    onSuccess: async (_data, nodeName) => {
      await queryClient.invalidateQueries({ queryKey: ['cluster', 'nodes'] })
      await queryClient.invalidateQueries({ queryKey: ['cluster', 'nodes', 'describe', nodeName] })
    },
  })

  const drainMutation = useMutation({
    mutationFn: (nodeName: string) => api.drainNode(nodeName),
    onSuccess: (data) => {
      setDrainId(data.drain_id)
      setDrainStatus('draining')
      setDrainError(null)
    },
    onError: (error: any) => {
      setDrainStatus('error')
      setDrainError(error?.response?.data?.detail || error?.message || tr('nodes.drain.error', 'Failed to drain node.'))
    },
  })

  const isSchedulingMutation = cordonMutation.isPending || uncordonMutation.isPending
  const isDrainMutation = drainMutation.isPending || drainStatus === 'draining' || drainStatus === 'pending'
  const disableSchedulingAction = isSchedulingMutation || isDrainMutation
  const disableDrainAction = isDrainMutation || isSchedulingMutation
  const showDrainStatus = drainStatus !== 'idle' || Boolean(drainId) || Boolean(drainError)

  const drainStatusMeta = useMemo(() => {
    const status = drainStatus
    if (status === 'success') {
      return {
        icon: CheckCircle2,
        label: tr('nodes.drain.status.success', 'Completed'),
        tone: 'text-emerald-400',
        bg: 'bg-emerald-500/10',
        border: 'border-emerald-500/20',
      }
    }
    if (status === 'error') {
      return {
        icon: AlertTriangle,
        label: tr('nodes.drain.status.error', 'Failed'),
        tone: 'text-red-400',
        bg: 'bg-red-500/10',
        border: 'border-red-500/20',
      }
    }
    if (status === 'pending') {
      return {
        icon: Clock,
        label: tr('nodes.drain.status.pending', 'Queued'),
        tone: 'text-amber-300',
        bg: 'bg-amber-500/10',
        border: 'border-amber-500/20',
      }
    }
    if (status === 'draining') {
      return {
        icon: Loader2,
        label: tr('nodes.drain.status.draining', 'Draining'),
        tone: 'text-sky-300',
        bg: 'bg-sky-500/10',
        border: 'border-sky-500/20',
      }
    }
    return {
      icon: Clock,
      label: tr('nodes.drain.status.pending', 'Queued'),
      tone: 'text-amber-300',
      bg: 'bg-amber-500/10',
      border: 'border-amber-500/20',
    }
  }, [drainStatus, tr])

  const drainStatusMessage =
    drainError || drainStatusData?.message || (drainStatus === 'success'
      ? tr('nodes.drain.status.doneMessage', 'Node drain completed.')
      : drainStatus === 'draining'
        ? tr('nodes.drain.status.progressMessage', 'Evicting pods from the node...')
        : drainStatus === 'pending'
          ? tr('nodes.drain.status.pendingMessage', 'Drain request accepted. Waiting to start...')
          : '')

  const handleApplyYaml = async (nextValue: string) => {
    if (!selectedNodeName) return
    await api.applyNodeYaml(selectedNodeName, nextValue)
    setYamlRefreshNonce((prev) => prev + 1)
    await queryClient.invalidateQueries({ queryKey: ['cluster', 'nodes', 'describe', selectedNodeName] })
    await queryClient.invalidateQueries({ queryKey: ['cluster', 'nodes'] })
  }

  const handleToggleScheduling = () => {
    if (!selectedNodeName || !nodeDescribe || isSchedulingMutation) return
    if (nodeDescribe.unschedulable) {
      uncordonMutation.mutate(selectedNodeName)
    } else {
      cordonMutation.mutate(selectedNodeName)
    }
  }

  const openDrainDialog = () => {
    setDrainDialogOpen(true)
    setDrainError(null)
  }

  const closeDrainDialog = () => {
    setDrainDialogOpen(false)
  }

  const handleDrainConfirm = () => {
    if (!selectedNodeName) return
    setDrainStatus('pending')
    setDrainError(null)
    setDrainDialogOpen(false)
    drainMutation.mutate(selectedNodeName)
  }

  useEffect(() => {
    if (!drainStatusData) return
    const status = drainStatusData.status
    if (status === 'success') {
      setDrainStatus('success')
      setDrainId(null)
      queryClient.invalidateQueries({ queryKey: ['cluster', 'nodes'] })
      if (selectedNodeName) {
        queryClient.invalidateQueries({ queryKey: ['cluster', 'nodes', 'describe', selectedNodeName] })
        queryClient.invalidateQueries({ queryKey: ['cluster', 'nodes', 'pods', selectedNodeName] })
        queryClient.invalidateQueries({ queryKey: ['cluster', 'nodes', 'events', selectedNodeName] })
      }
    } else if (status === 'error') {
      setDrainStatus('error')
      setDrainError(drainStatusData.message || tr('nodes.drain.error', 'Failed to drain node.'))
      setDrainId(null)
    } else {
      setDrainStatus(status as typeof drainStatus)
    }
  }, [drainStatusData, queryClient, selectedNodeName, tr])

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

  const formatPodAge = (iso?: string | null) => {
    if (!iso) return '-'
    const date = new Date(iso)
    const diffSec = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000))
    const days = Math.floor(diffSec / 86400)
    const hours = Math.floor((diffSec % 86400) / 3600)
    const minutes = Math.floor((diffSec % 3600) / 60)
    if (days > 0) return `${days}d ${hours}h`
    if (hours > 0) return `${hours}h ${minutes}m`
    return `${minutes}m`
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

  const sortedEvents = useMemo(() => {
    if (!Array.isArray(nodeEvents)) return []
    const getTime = (e: NodeEvent) => {
      const ts = e.last_timestamp || e.first_timestamp
      if (!ts) return 0
      const d = new Date(ts).getTime()
      return Number.isFinite(d) ? d : 0
    }
    return [...nodeEvents].sort((a, b) => getTime(b) - getTime(a))
  }, [nodeEvents])

  const getEventBadge = (type?: string | null) => {
    const tval = (type || '').toLowerCase()
    if (tval.includes('warning')) return 'badge-warning'
    if (tval.includes('error') || tval.includes('failed')) return 'badge-error'
    return 'badge-info'
  }

  useEffect(() => {
    setPodPage(1)
  }, [podFilter, selectedNodeName])

  useEffect(() => {
    setDetailTab('info')
    setYamlRefreshNonce(0)
  }, [selectedNodeName])

  const filteredNodePods = useMemo(() => {
    if (!Array.isArray(nodePods)) return []
    if (!podFilter.trim()) return nodePods
    const q = podFilter.toLowerCase()
    return nodePods.filter(
      (pod) =>
        pod.name.toLowerCase().includes(q) ||
        pod.namespace.toLowerCase().includes(q)
    )
  }, [nodePods, podFilter])

  const podsPageSize = 10
  const podTotalPages = Math.max(1, Math.ceil(filteredNodePods.length / podsPageSize))
  const pagedPods = useMemo(() => {
    const start = (podPage - 1) * podsPageSize
    return filteredNodePods.slice(start, start + podsPageSize)
  }, [filteredNodePods, podPage])
  const emptyPodRows = Math.max(0, podsPageSize - pagedPods.length)

  const metricForSelected = selectedNodeName ? metricsMap.get(selectedNodeName) : undefined
  const cpuPercent = metricForSelected ? parseFloat(metricForSelected.cpu_percent) : 0
  const memPercent = metricForSelected ? parseFloat(metricForSelected.memory_percent) : 0

  const UsageCard = ({
    label,
    value,
    percent,
    color,
  }: {
    label: string
    value: string
    percent: number
    color: string
  }) => (
    <div className="rounded-lg border border-slate-700 bg-slate-900/60 px-4 py-3">
      <p className="text-xs text-slate-400">{label}</p>
      <p className="text-base text-white mt-1">{value}</p>
      <div className="mt-3 w-full h-2.5 bg-slate-800 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.min(Math.max(percent, 0), 100)}%`, backgroundColor: color }}
        />
      </div>
    </div>
  )

  const filteredNodes = useMemo(() => {
    if (!Array.isArray(nodes)) return [] as NodeInfo[]
    if (!searchQuery.trim()) return nodes as NodeInfo[]
    const q = searchQuery.toLowerCase()
    return (nodes as NodeInfo[]).filter((node) => node.name.toLowerCase().includes(q))
  }, [nodes, searchQuery])

  const parseAgeDays = (age?: string | null) => {
    if (!age) return 0
    const match = age.match(/(\\d+)\\s+day/)
    if (match) return Number(match[1]) || 0
    return 0
  }

  const formatAgeDays = (age?: string | null) => {
    const days = parseAgeDays(age)
    return `${days}d`
  }

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

  const sortedNodes = useMemo(() => {
    if (!sortKey) return filteredNodes
    const list = [...filteredNodes]
    const getValue = (node: NodeInfo) => {
      switch (sortKey) {
        case 'name':
          return node.name
        case 'status':
          return node.status || ''
        case 'roles':
          return (node.roles || []).join(',')
        case 'cpu': {
          const metric = metricsMap.get(node.name)
          return metric ? parseFloat(metric.cpu_percent) || 0 : 0
        }
        case 'memory': {
          const metric = metricsMap.get(node.name)
          return metric ? parseFloat(metric.memory_percent) || 0 : 0
        }
        case 'version':
          return node.version || ''
        case 'internal_ip':
          return node.internal_ip || ''
        case 'external_ip':
          return node.external_ip || ''
        case 'age':
          return parseAgeDays(node.age)
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
  }, [filteredNodes, metricsMap, sortDir, sortKey])

  const topNodes = useMemo(() => {
    if (!Array.isArray(metrics) || metrics.length === 0) return [] as NodeMetric[]
    const parsePercent = (value: string | undefined) => {
      if (!value) return 0
      const numeric = Number(String(value).replace('%', ''))
      return Number.isFinite(numeric) ? numeric : 0
    }
    return [...metrics]
      .map((node) => {
        const cpuPercent = parsePercent(node.cpu_percent)
        const memPercent = parsePercent(node.memory_percent)
        return {
          ...node,
          _score: cpuPercent * 0.7 + memPercent * 0.3,
        } as NodeMetric & { _score: number }
      })
      .sort((a, b) => b._score - a._score)
      .slice(0, 3)
  }, [metrics])

  const getStatusColor = (status: string) => {
    const lower = (status || '').toLowerCase()
    if (lower.includes('ready')) return 'badge-success'
    if (lower.includes('notready') || lower.includes('unknown')) return 'badge-warning'
    return 'badge-info'
  }

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const [nodesData, metricsData] = await Promise.all([api.getNodes(true), api.getNodeMetrics()])
      queryClient.removeQueries({ queryKey: ['cluster', 'nodes'] })
      queryClient.setQueryData(['cluster', 'nodes'], nodesData)
      queryClient.setQueryData(['cluster', 'node-metrics'], metricsData)
    } catch (error) {
      console.error('Nodes refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('nodes.title', 'Nodes')}</h1>
          <p className="mt-2 text-slate-400">{tr('nodes.subtitle', 'Inspect cluster node status and capacity.')}</p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={isRefreshing}
          title={tr('nodes.refreshTitle', 'Force refresh')}
          className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          {tr('nodes.refresh', 'Refresh')}
        </button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
        <input
          type="text"
          placeholder={tr('nodes.searchPlaceholder', 'Search nodes by name...')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-10 pr-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
        />
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-white">
            {tr('nodes.top.title', 'Top nodes by resource usage')}
          </h2>
          <Server className="w-4 h-4 text-slate-400" />
        </div>
        {isLoadingMetrics ? (
          <p className="text-sm text-slate-400">{tr('nodes.top.loading', 'Loading metrics...')}</p>
        ) : isMetricsError ? (
          <p className="text-sm text-slate-400">{tr('nodes.top.error', 'Metrics unavailable')}</p>
        ) : topNodes.length > 0 ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {topNodes.map((node, index) => {
              const cpuPercent = parseFloat(node.cpu_percent)
              const memPercent = parseFloat(node.memory_percent)
              return (
                <div key={node.name} className="rounded-lg border border-slate-700 bg-slate-900/40 px-4 py-3">
                  <div className="flex items-center justify-between text-sm text-white">
                    <span className="font-medium">#{index + 1} {node.name}</span>
                    <span className="text-xs text-slate-400">{node.cpu} / {node.memory}</span>
                  </div>
                  <div className="mt-3 space-y-2">
                    <div className="text-xs text-slate-400 flex items-center justify-between">
                      <span>CPU</span>
                      <span className="font-medium text-emerald-300">{node.cpu_percent}</span>
                    </div>
                    <div className="w-full h-2.5 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${cpuPercent >= 80 ? 'bg-red-500' : cpuPercent >= 60 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                        style={{ width: `${Math.min(cpuPercent, 100)}%` }}
                      />
                    </div>
                    <div className="text-xs text-slate-400 flex items-center justify-between">
                      <span>MEM</span>
                      <span className="font-medium text-blue-300">{node.memory_percent}</span>
                    </div>
                    <div className="w-full h-2.5 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${memPercent >= 80 ? 'bg-red-500' : memPercent >= 60 ? 'bg-amber-500' : 'bg-blue-500'}`}
                        style={{ width: `${Math.min(memPercent, 100)}%` }}
                      />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="text-sm text-slate-400">{tr('nodes.top.empty', 'No metrics available')}</p>
        )}
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm min-w-[980px] table-fixed">
          <thead className="text-slate-400">
            <tr>
              <th className="text-left py-3 px-4 w-[260px] cursor-pointer" onClick={() => handleSort('name')}>
                <span className="inline-flex items-center gap-1">{tr('nodes.table.name', 'Name')}{renderSortIcon('name')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('status')}>
                <span className="inline-flex items-center gap-1">{tr('nodes.table.status', 'Status')}{renderSortIcon('status')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[180px] cursor-pointer" onClick={() => handleSort('roles')}>
                <span className="inline-flex items-center gap-1">{tr('nodes.table.roles', 'Roles')}{renderSortIcon('roles')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[150px] cursor-pointer" onClick={() => handleSort('cpu')}>
                <span className="inline-flex items-center gap-1">{tr('nodes.table.cpu', 'CPU')}{renderSortIcon('cpu')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[170px] cursor-pointer" onClick={() => handleSort('memory')}>
                <span className="inline-flex items-center gap-1">{tr('nodes.table.memory', 'Memory')}{renderSortIcon('memory')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[160px] cursor-pointer" onClick={() => handleSort('version')}>
                <span className="inline-flex items-center gap-1">{tr('nodes.table.version', 'Version')}{renderSortIcon('version')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[150px] cursor-pointer" onClick={() => handleSort('internal_ip')}>
                <span className="inline-flex items-center gap-1">{tr('nodes.table.internalIp', 'Internal IP')}{renderSortIcon('internal_ip')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[150px] cursor-pointer" onClick={() => handleSort('external_ip')}>
                <span className="inline-flex items-center gap-1">{tr('nodes.table.externalIp', 'External IP')}{renderSortIcon('external_ip')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[110px] cursor-pointer" onClick={() => handleSort('age')}>
                <span className="inline-flex items-center gap-1">{tr('nodes.table.age', 'Age')}{renderSortIcon('age')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {sortedNodes.map((node) => {
              const metric = metricsMap.get(node.name)
              return (
                <tr
                  key={node.name}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => setSelectedNodeName(node.name)}
                >
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{node.name}</span></td>
                  <td className="py-3 px-4">
                    <span className={`badge ${getStatusColor(node.status)}`}>{node.status}</span>
                  </td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{node.roles && node.roles.length > 0 ? node.roles.join(', ') : '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{metric ? `${metric.cpu} (${metric.cpu_percent})` : '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{metric ? `${metric.memory} (${metric.memory_percent})` : '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{node.version || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{node.internal_ip || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{node.external_ip || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{formatAgeDays(node.age)}</span></td>
                </tr>
              )
            })}
            {sortedNodes.length === 0 && !isLoadingNodes && (
              <tr>
                <td colSpan={9} className="py-6 px-4 text-slate-400">
                  {tr('nodes.noResults', 'No nodes found.')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selectedNodeName && (
        <ModalOverlay onClose={() => setSelectedNodeName(null)}>
          <div
            className="fixed inset-y-0 right-0 w-full max-w-[560px] bg-slate-900 border-l border-slate-700 shadow-2xl flex flex-col overflow-x-hidden"
            onClick={(e) => e.stopPropagation()}
          >
              <div className="flex items-start justify-between px-5 py-4 border-b border-slate-700">
              <div>
                <h2 className="text-lg font-semibold text-white">{selectedNodeName}</h2>
                <p className="text-xs text-slate-400">
                  {tr('nodes.detail.subtitle', 'Details from kubectl describe node {{name}}', {
                    name: selectedNodeName,
                  })}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {isAdmin && nodeDescribe && (
                  <button
                    type="button"
                    onClick={handleToggleScheduling}
                    disabled={disableSchedulingAction}
                    title={
                      disableSchedulingAction
                        ? tr('nodes.actions.schedulingDisabled', 'Action disabled while another operation is running.')
                        : undefined
                    }
                    className="text-xs px-3 py-1 rounded-md border border-slate-700 bg-slate-800 text-white hover:border-slate-500 disabled:opacity-60"
                  >
                    {isSchedulingMutation
                      ? nodeDescribe.unschedulable
                        ? tr('nodes.actions.uncordoning', 'Uncordoning...')
                        : tr('nodes.actions.cordoning', 'Cordoning...')
                      : nodeDescribe.unschedulable
                        ? tr('nodes.actions.uncordon', 'Uncordon')
                        : tr('nodes.actions.cordon', 'Cordon')}
                  </button>
                )}
                {isAdmin && nodeDescribe && (
                  <button
                    type="button"
                    onClick={openDrainDialog}
                    disabled={disableDrainAction}
                    title={
                      disableDrainAction
                        ? tr('nodes.actions.drainDisabled', 'Drain is disabled while another operation is running.')
                        : undefined
                    }
                    className="text-xs px-3 py-1 rounded-md border border-slate-700 bg-slate-800 text-white hover:border-slate-500 disabled:opacity-60"
                  >
                    {isDrainMutation
                      ? tr('nodes.actions.draining', 'Draining...')
                      : tr('nodes.actions.drain', 'Drain')}
                  </button>
                )}
                <button
                  onClick={() => setSelectedNodeName(null)}
                  className="text-slate-400 hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {(isSchedulingMutation || isDrainMutation) && (
              <div className="px-5 pb-2 text-[11px] text-slate-400">
                {isDrainMutation
                  ? tr('nodes.actions.drainInProgress', 'Drain in progress. Actions are temporarily disabled.')
                  : tr('nodes.actions.schedulingInProgress', 'Scheduling update in progress. Actions are temporarily disabled.')}
              </div>
            )}

            <div className="flex items-center gap-2 px-5 py-2 border-b border-slate-800 text-xs">
              <button
                type="button"
                onClick={() => setDetailTab('info')}
                className={`px-3 py-1 rounded-md border ${
                  detailTab === 'info'
                    ? 'border-slate-500 bg-slate-800 text-white'
                    : 'border-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                {tr('nodes.detail.tabs.info', 'Info')}
              </button>
              <button
                type="button"
                onClick={() => setDetailTab('yaml')}
                className={`px-3 py-1 rounded-md border ${
                  detailTab === 'yaml'
                    ? 'border-slate-500 bg-slate-800 text-white'
                    : 'border-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                {tr('nodes.detail.tabs.yaml', 'YAML')}
              </button>
            </div>

            {showDrainStatus && (
              <div className="px-5 py-3 border-b border-slate-800">
                <div className={`flex items-start gap-3 rounded-lg border px-3 py-2 ${drainStatusMeta.bg} ${drainStatusMeta.border}`}>
                  <div className={`mt-0.5 ${drainStatusMeta.tone}`}>
                    <drainStatusMeta.icon className={`w-4 h-4 ${drainStatus === 'draining' ? 'animate-spin' : ''}`} />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-semibold ${drainStatusMeta.tone}`}>
                        {tr('nodes.drain.status.title', 'Drain status')}: {drainStatusMeta.label}
                      </span>
                      {drainId && (
                        <span className="text-[11px] text-slate-400">
                          {tr('nodes.drain.status.id', 'ID')}: {drainId.slice(0, 8)}
                        </span>
                      )}
                    </div>
                    {drainStatusMessage && (
                      <div className="mt-1 text-xs text-slate-300">{drainStatusMessage}</div>
                    )}
                    {drainStatus === 'error' && drainError && (
                      <div className="mt-2 text-[11px] text-red-300 break-all">{drainError}</div>
                    )}
                  </div>
                </div>
              </div>
            )}

            <div className="flex-1 overflow-y-auto overflow-x-hidden p-5 space-y-6 text-sm">
              {detailTab === 'yaml' ? (
                <YamlEditor
                  key={`${selectedNodeName || 'node'}-${detailTab}`}
                  value={nodeYaml?.yaml || ''}
                  canEdit={canEditYaml}
                  isLoading={isYamlLoading}
                  isRefreshing={isYamlFetching}
                  error={isYamlError ? tr('nodes.detail.yaml.error', 'Failed to load YAML.') : null}
                  onRefresh={() => setYamlRefreshNonce((prev) => prev + 1)}
                  onApply={handleApplyYaml}
                  labels={{
                    title: tr('nodes.detail.yaml.title', 'Node YAML'),
                    refresh: tr('nodes.detail.yaml.refresh', 'Refresh'),
                    copy: tr('nodes.detail.yaml.copy', 'Copy'),
                    edit: tr('nodes.detail.yaml.edit', 'Edit'),
                    apply: tr('nodes.detail.yaml.apply', 'Apply'),
                    applying: tr('nodes.detail.yaml.applying', 'Applying...'),
                    cancel: tr('nodes.detail.yaml.cancel', 'Cancel'),
                    loading: tr('nodes.detail.yaml.loading', 'Loading YAML...'),
                    error: tr('nodes.detail.yaml.error', 'Failed to load YAML.'),
                    readonly: tr('nodes.detail.yaml.readonly', 'Read-only for non-admin users.'),
                    editHint: tr('nodes.detail.yaml.editHint', 'Edit is available for admin users.'),
                    applied: tr('nodes.detail.yaml.applied', 'Applied'),
                    refreshing: tr('nodes.detail.yaml.refreshing', 'Refreshing...'),
                  }}
                />
              ) : isLoadingDescribe ? (
                <p className="text-slate-400">{tr('nodes.detail.loading', 'Loading node details...')}</p>
              ) : isDescribeError ? (
                <p className="text-red-400">{tr('nodes.detail.error', 'Failed to load node details.')}</p>
              ) : nodeDescribe ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    {(() => {
                      const readyCondition = nodeDescribe.conditions?.find((c) => c.type === 'Ready')
                      const isReady = readyCondition?.status === 'True'
                      const taintCount = nodeDescribe.taints?.length || 0
                      const conditionCount = nodeDescribe.conditions?.length || 0
                      const unhealthyCount = nodeDescribe.conditions?.filter((c) => c.status !== 'True').length || 0

                      return (
                        <>
                          <span
                            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                              isReady ? 'border-emerald-500/60 text-emerald-300' : 'border-red-500/60 text-red-300'
                            }`}
                          >
                            {tr('nodes.detail.summary.ready', 'Ready')}:{' '}
                            {isReady ? tr('nodes.detail.summary.readyYes', 'Yes') : tr('nodes.detail.summary.readyNo', 'No')}
                          </span>
                          <span
                            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                              taintCount > 0 ? 'border-amber-500/60 text-amber-300' : 'border-slate-600 text-slate-300'
                            }`}
                          >
                            {tr('nodes.detail.summary.taints', 'Taints')}: {taintCount}
                          </span>
                          <span
                            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                              unhealthyCount > 0 ? 'border-amber-500/60 text-amber-300' : 'border-slate-600 text-slate-300'
                            }`}
                          >
                            {tr('nodes.detail.summary.conditions', 'Conditions')}: {conditionCount}
                          </span>
                        </>
                      )
                    })()}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="rounded-lg border border-slate-700 bg-slate-900/60 px-4 py-3">
                      <p className="text-xs text-slate-400">{tr('nodes.detail.uptime', 'Uptime')}</p>
                      <p className="text-base text-white mt-1">
                        {formatRelative(
                          nodeDescribe.conditions?.find((c) => c.type === 'Ready')?.last_transition_time
                        )}
                      </p>
                    </div>
                    <UsageCard
                      label={tr('nodes.detail.cpuUsage', 'CPU Usage')}
                      value={`${metricForSelected?.cpu || '-'} (${metricForSelected?.cpu_percent || '-'})`}
                      percent={Number.isFinite(cpuPercent) ? cpuPercent : 0}
                      color={cpuPercent >= 80 ? '#ef4444' : cpuPercent >= 60 ? '#f59e0b' : '#10b981'}
                    />
                    <UsageCard
                      label={tr('nodes.detail.memoryUsage', 'Memory Usage')}
                      value={`${metricForSelected?.memory || '-'} (${metricForSelected?.memory_percent || '-'})`}
                      percent={Number.isFinite(memPercent) ? memPercent : 0}
                      color={memPercent >= 80 ? '#ef4444' : memPercent >= 60 ? '#f59e0b' : '#3b82f6'}
                    />
                  </div>

                  <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
                    <p className="text-xs text-slate-400 mb-2">{tr('nodes.detail.system', 'System info')}</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs text-slate-200">
                      <div>{tr('nodes.detail.systemOs', 'OS')}: {nodeDescribe.system_info?.operating_system || '-'}</div>
                      <div>{tr('nodes.detail.systemArch', 'Arch')}: {nodeDescribe.system_info?.architecture || '-'}</div>
                      <div>{tr('nodes.detail.systemImage', 'OS Image')}: {nodeDescribe.system_info?.os_image || '-'}</div>
                      <div>{tr('nodes.detail.systemKernel', 'Kernel')}: {nodeDescribe.system_info?.kernel_version || '-'}</div>
                      <div>{tr('nodes.detail.systemRuntime', 'Runtime')}: {nodeDescribe.system_info?.container_runtime || '-'}</div>
                      <div>{tr('nodes.detail.systemKubelet', 'Kubelet')}: {nodeDescribe.system_info?.kubelet_version || '-'}</div>
                      <div>{tr('nodes.detail.systemProxy', 'Kube Proxy')}: {nodeDescribe.system_info?.kube_proxy_version || '-'}</div>
                      <div>{tr('nodes.detail.systemBootId', 'Boot ID')}: {nodeDescribe.system_info?.boot_id || '-'}</div>
                      <div>{tr('nodes.detail.systemMachineId', 'Machine ID')}: {nodeDescribe.system_info?.machine_id || '-'}</div>
                      <div>{tr('nodes.detail.systemUuid', 'System UUID')}: {nodeDescribe.system_info?.system_uuid || '-'}</div>
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
                    <p className="text-xs text-slate-400 mb-2">{tr('nodes.detail.conditions', 'Conditions')}</p>
                    <div className="space-y-2 text-xs text-slate-200">
                      {nodeDescribe.conditions && nodeDescribe.conditions.length > 0
                        ? nodeDescribe.conditions.map((c, idx) => (
                            <div key={`${c.type}-${idx}`} className="flex items-start justify-between gap-4">
                              <div>
                                <div className="font-medium text-white">{c.type}</div>
                                <div className="text-slate-400">{c.reason || '-'}</div>
                              </div>
                              <div className="text-right text-slate-400">
                                <div>{c.status}</div>
                                <div>{formatRelative(c.last_transition_time)}</div>
                              </div>
                            </div>
                          ))
                        : tr('common.none', '(none)')}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
                      <p className="text-xs text-slate-400 mb-2">{tr('nodes.detail.addresses', 'Addresses')}</p>
                      <div className="text-xs text-slate-200 whitespace-pre-wrap break-all">
                        {nodeDescribe.addresses && nodeDescribe.addresses.length > 0
                          ? nodeDescribe.addresses.map((a) => `${a.type}: ${a.address}`).join('\n')
                          : tr('common.none', '(none)')}
                      </div>
                    </div>
                    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
                      <p className="text-xs text-slate-400 mb-2">{tr('nodes.detail.taints', 'Taints')}</p>
                      <div className="text-xs text-slate-200 whitespace-pre-wrap break-all">
                        {nodeDescribe.taints && nodeDescribe.taints.length > 0
                          ? nodeDescribe.taints
                              .map((t) => `${t.key || ''}=${t.value || ''}:${t.effect || ''}`)
                              .join('\n')
                          : tr('common.none', '(none)')}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
                      <p className="text-xs text-slate-400 mb-2">{tr('nodes.detail.version', 'Versions')}</p>
                      <div className="text-xs text-slate-200">
                      <div>{tr('nodes.detail.createdAt', 'Created')}: {formatTimestamp(nodeDescribe.created_at)}</div>
                      <div>{tr('nodes.detail.podCidr', 'Pod CIDR')}: {nodeDescribe.pod_cidr || '-'}</div>
                      <div>{tr('nodes.detail.scheduling', 'Scheduling')}: {nodeDescribe.unschedulable ? tr('nodes.detail.schedulingDisabled', 'Disabled') : tr('nodes.detail.schedulingEnabled', 'Enabled')}</div>
                      </div>
                  </div>

                  <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
                    <p className="text-xs text-slate-400 mb-2">{tr('nodes.detail.labels', 'Labels')}</p>
                    {renderKeyValueList(nodeDescribe.labels)}
                  </div>

                  <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
                    <p className="text-xs text-slate-400 mb-2">{tr('nodes.detail.annotations', 'Annotations')}</p>
                    {renderKeyValueList(nodeDescribe.annotations)}
                  </div>

                  <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
                    <div className="flex items-center justify-between gap-2 mb-3">
                      <p className="text-xs text-slate-400">{tr('nodes.detail.pods', 'Pods')}</p>
                      <input
                        type="text"
                        value={podFilter}
                        onChange={(e) => setPodFilter(e.target.value)}
                        placeholder={tr('nodes.pods.search', 'Filter pods...')}
                        className="bg-slate-800 border border-slate-700 rounded-md px-2 py-1 text-xs text-slate-200 placeholder:text-slate-500"
                      />
                    </div>
                    <div className="flex flex-col gap-2">
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs min-w-[980px] table-fixed">
                        <thead className="text-slate-400">
                          <tr>
                            <th className="text-left py-2 w-[32%]">{tr('nodes.pods.table.name', 'Name')}</th>
                            <th className="text-left py-2 w-[16%]">{tr('nodes.pods.table.namespace', 'Namespace')}</th>
                            <th className="text-left py-2 w-[10%]">{tr('nodes.pods.table.ready', 'Ready')}</th>
                            <th className="text-left py-2 w-[12%]">{tr('nodes.pods.table.status', 'Status')}</th>
                            <th className="text-left py-2 w-[10%]">{tr('nodes.pods.table.restarts', 'Restarts')}</th>
                            <th className="text-left py-2 w-[12%]">{tr('nodes.pods.table.ip', 'IP')}</th>
                            <th className="text-left py-2 w-[8%]">{tr('nodes.pods.table.age', 'Age')}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800">
                          {pagedPods.map((pod) => (
                            <tr key={`${pod.namespace}-${pod.name}`} className="text-slate-200">
                              <td className="py-2 pr-2 font-medium text-white"><span className="block truncate">{pod.name}</span></td>
                              <td className="py-2 pr-2"><span className="block truncate">{pod.namespace}</span></td>
                              <td className="py-2 pr-2">{pod.ready || '-'}</td>
                              <td className="py-2 pr-2"><span className="block truncate">{pod.status || pod.phase || '-'}</span></td>
                              <td className="py-2 pr-2">{pod.restart_count ?? 0}</td>
                              <td className="py-2 pr-2"><span className="block truncate">{pod.pod_ip || '-'}</span></td>
                              <td className="py-2 pr-2">{formatPodAge(pod.created_at)}</td>
                            </tr>
                          ))}
                          {emptyPodRows > 0 &&
                            Array.from({ length: emptyPodRows }).map((_, idx) => (
                              <tr key={`empty-${idx}`} className="text-slate-700">
                                <td className="py-2 pr-2">&nbsp;</td>
                                <td className="py-2 pr-2">&nbsp;</td>
                                <td className="py-2 pr-2">&nbsp;</td>
                                <td className="py-2 pr-2">&nbsp;</td>
                                <td className="py-2 pr-2">&nbsp;</td>
                                <td className="py-2 pr-2">&nbsp;</td>
                                <td className="py-2 pr-2">&nbsp;</td>
                              </tr>
                            ))}
                          {pagedPods.length === 0 && (
                            <tr>
                              <td colSpan={7} className="py-4 text-slate-400">
                                {tr('common.none', '(none)')}
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                      </div>
                      <div className="flex items-center justify-between text-xs text-slate-400 pt-1 border-t border-slate-800">
                        <span>
                          {filteredNodePods.length === 0
                            ? tr('common.none', '(none)')
                            : `${(podPage - 1) * podsPageSize + 1}-${Math.min(
                                podPage * podsPageSize,
                                filteredNodePods.length
                              )} / ${filteredNodePods.length}`}
                        </span>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setPodPage((prev) => Math.max(1, prev - 1))}
                            disabled={podPage === 1}
                            className="px-2 py-1 rounded border border-slate-700 disabled:opacity-40"
                          >
                            {tr('nodes.pods.prev', 'Prev')}
                          </button>
                          <button
                            type="button"
                            onClick={() => setPodPage((prev) => Math.min(podTotalPages, prev + 1))}
                            disabled={podPage >= podTotalPages}
                            className="px-2 py-1 rounded border border-slate-700 disabled:opacity-40"
                          >
                            {tr('nodes.pods.next', 'Next')}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
                    <p className="text-xs text-slate-400 mb-2">{tr('nodes.detail.events', 'Events')}</p>
                    {sortedEvents.length > 0 ? (
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs table-fixed min-w-[620px]">
                          <thead className="text-slate-400">
                            <tr>
                              <th className="text-left py-2 w-[12%]">{tr('nodes.events.table.type', 'Type')}</th>
                              <th className="text-left py-2 w-[18%]">{tr('nodes.events.table.reason', 'Reason')}</th>
                              <th className="text-left py-2 w-[44%]">{tr('nodes.events.table.message', 'Message')}</th>
                              <th className="text-left py-2 w-[14%]">{tr('nodes.events.table.lastSeen', 'Last Seen')}</th>
                              <th className="text-left py-2 w-[12%]">{tr('nodes.events.table.count', 'Count')}</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-800">
                            {sortedEvents.slice(0, 50).map((event, idx) => (
                              <tr key={`${event.reason}-${idx}`} className="text-slate-200">
                                <td className="py-2 pr-2">
                                  <span className={`badge ${getEventBadge(event.type)}`}>{event.type || '-'}</span>
                                </td>
                                <td className="py-2 pr-2 align-top">
                                  <span className="block break-words whitespace-normal">
                                    {event.reason || '-'}
                                  </span>
                                </td>
                                <td className="py-2 pr-2 align-top">
                                  <span className="block break-words whitespace-normal">
                                    {event.message || '-'}
                                  </span>
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
                <p className="text-slate-400">{tr('nodes.detail.notFound', 'Node details not found.')}</p>
              )}
            </div>
          </div>
        </ModalOverlay>
      )}

      {drainDialogOpen && selectedNodeName && (
        <ModalOverlay onClose={closeDrainDialog}>
          <div
            className="bg-slate-800 rounded-lg w-full max-w-lg p-6"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={tr('nodes.drain.title', 'Drain node')}
          >
            <h2 className="text-xl font-bold text-white mb-4">
              {tr('nodes.drain.title', 'Drain node')}
            </h2>
            <p className="text-slate-300 leading-relaxed">
              {tr('nodes.drain.confirm', 'Are you sure you want to drain node {{name}}?', {
                name: selectedNodeName,
              })}
            </p>
            <p className="text-slate-400 mt-3">
              {tr(
                'nodes.drain.warning',
                'Draining will evict pods from this node. Be sure you understand the impact before continuing.'
              )}
            </p>

            {drainError && (
              <div className="mt-4 text-sm text-red-400">{drainError}</div>
            )}

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={closeDrainDialog}
                disabled={isDrainMutation}
              >
                {tr('common.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                className="btn bg-red-600 hover:bg-red-700 text-white disabled:opacity-60"
                onClick={handleDrainConfirm}
                disabled={isDrainMutation}
              >
                {tr('nodes.drain.confirmButton', 'Drain')}
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}
    </div>
  )
}
