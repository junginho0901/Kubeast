import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { useAIContext } from '@/hooks/useAIContext'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import {
  RefreshCw,
  Box,
  Loader2,
  Search,
  ChevronUp,
  ChevronDown,
  BarChart3,
} from 'lucide-react'

import type { GPUDashboardData, GPUMetricsData, GPUPodInfo } from '@/services/api'

type SortKey = null | 'namespace' | 'name' | 'node_name' | 'gpu_requested' | 'status' | 'age'
type SummaryCard = [label: string, value: number | string, boxClass: string, labelClass: string]

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

function getStatusColor(status: string): string {
  const lower = (status || '').toLowerCase()
  if (lower === 'running' || lower === 'succeeded' || lower === 'completed') return 'badge-success'
  if (lower === 'pending') return 'badge-warning'
  if (lower === 'failed' || lower.includes('error') || lower.includes('backoff')) return 'badge-error'
  return 'badge-info'
}

export default function GPUPods() {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const { open: openDetail } = useResourceDetail()

  const [searchQuery, setSearchQuery] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [currentPage, setCurrentPage] = useState(1)
  const [showCharts, setShowCharts] = useState(false)

  const { data, isLoading, refetch } = useQuery<GPUDashboardData>({
    queryKey: ['gpu', 'dashboard'],
    queryFn: () => api.getGPUDashboard(),
    refetchInterval: 30000,
    retry: 2,
    retryDelay: 1000,
  })

  const { data: metrics } = useQuery<GPUMetricsData>({
    queryKey: ['gpu', 'metrics'],
    queryFn: () => api.getGPUMetrics(),
    refetchInterval: 15000,
    retry: 1,
  })

  const metricsAvailable = metrics?.available ?? false

  // Build pod→GPU metrics lookup
  const podMetricsMap = useMemo(() => {
    if (!metrics?.gpus) return new Map<string, { gpu_util: number; memory_util_percent: number; memory_used_mb: number; memory_total_mb: number; model_name: string }>()
    const map = new Map<string, { gpu_util: number; memory_util_percent: number; memory_used_mb: number; memory_total_mb: number; model_name: string }>()
    for (const gpu of metrics.gpus) {
      if (gpu.exported_pod && gpu.exported_namespace) {
        const key = `${gpu.exported_namespace}/${gpu.exported_pod}`
        map.set(key, {
          gpu_util: gpu.gpu_util,
          memory_util_percent: gpu.memory_util_percent,
          memory_used_mb: gpu.memory_used_mb,
          memory_total_mb: gpu.memory_total_mb,
          model_name: gpu.model_name,
        })
      }
    }
    return map
  }, [metrics])

  const pods = data?.gpu_pods ?? []

  const filteredPods = useMemo(() => {
    if (!searchQuery.trim()) return pods
    const q = searchQuery.toLowerCase()
    return pods.filter(
      (pod) =>
        pod.name.toLowerCase().includes(q) ||
        pod.namespace.toLowerCase().includes(q) ||
        (pod.node_name ?? '').toLowerCase().includes(q),
    )
  }, [pods, searchQuery])

  const stats = useMemo(() => {
    const total = pods.length
    const running = pods.filter((p) => p.status === 'Running').length
    const pending = pods.filter((p) => p.status === 'Pending').length
    const failed = pods.filter((p) => {
      const s = p.status.toLowerCase()
      return s === 'failed' || s.includes('error') || s.includes('backoff')
    }).length
    const totalGpuRequested = pods.reduce((sum, p) => sum + p.gpu_requested, 0)
    const namespaces = new Set(pods.map((p) => p.namespace)).size

    // Status distribution
    const statusMap = new Map<string, number>()
    for (const pod of pods) {
      statusMap.set(pod.status, (statusMap.get(pod.status) || 0) + 1)
    }
    const topStatuses = [...statusMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)

    return { total, running, pending, failed, totalGpuRequested, namespaces, topStatuses }
  }, [pods])

  const summaryCards = useMemo<SummaryCard[]>(
    () => [
      [tr('gpuPods.stats.total', 'Total Pods'), stats.total, 'border-slate-700 bg-slate-900/50', 'text-slate-400'],
      [tr('gpuPods.stats.running', 'Running'), stats.running, 'border-emerald-700/40 bg-emerald-900/10', 'text-emerald-300'],
      [tr('gpuPods.stats.pending', 'Pending'), stats.pending, 'border-yellow-700/40 bg-yellow-900/10', 'text-yellow-300'],
      [tr('gpuPods.stats.failed', 'Failed'), stats.failed, 'border-rose-700/40 bg-rose-900/10', 'text-rose-300'],
      [tr('gpuPods.stats.gpuRequested', 'GPUs Requested'), stats.totalGpuRequested, 'border-violet-700/40 bg-violet-900/10', 'text-violet-300'],
      [tr('gpuPods.stats.namespaces', 'Namespaces'), stats.namespaces, 'border-cyan-700/40 bg-cyan-900/10', 'text-cyan-300'],
    ],
    [stats, tr],
  )

  // GPU usage per node for the top section
  const nodeGpuUsage = useMemo(() => {
    const map = new Map<string, { podCount: number; totalGpu: number }>()
    for (const pod of pods) {
      const node = pod.node_name ?? 'Unassigned'
      const entry = map.get(node) ?? { podCount: 0, totalGpu: 0 }
      entry.podCount += 1
      entry.totalGpu += pod.gpu_requested
      map.set(node, entry)
    }
    return [...map.entries()]
      .sort((a, b) => b[1].totalGpu - a[1].totalGpu)
      .slice(0, 4)
  }, [pods])

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
    return sortDir === 'asc' ? (
      <ChevronUp className="w-3.5 h-3.5 text-slate-300" />
    ) : (
      <ChevronDown className="w-3.5 h-3.5 text-slate-300" />
    )
  }

  const sortedPods = useMemo(() => {
    if (!sortKey) return filteredPods
    const list = [...filteredPods]
    const getValue = (pod: GPUPodInfo): string | number => {
      switch (sortKey) {
        case 'namespace': return pod.namespace
        case 'name': return pod.name
        case 'node_name': return pod.node_name ?? ''
        case 'gpu_requested': return pod.gpu_requested
        case 'status': return pod.status
        case 'age': return parseAgeSeconds(pod.created_at)
        default: return ''
      }
    }
    list.sort((a, b) => {
      const av = getValue(a)
      const bv = getValue(b)
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av
      }
      return sortDir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av))
    })
    return list
  }, [filteredPods, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedPods.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedPods.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const pagedPods = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedPods.slice(start, start + rowsPerPage)
  }, [sortedPods, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (pods.length === 0) return null
    const total = pods.length
    const totalGpuRequested = pods.reduce((s, p) => s + (p.gpu_requested ?? 0), 0)
    const notRunning = pods.filter((p) => !/running/i.test(p.status)).length
    const prefix = notRunning > 0 ? '⚠️ ' : ''
    return {
      source: 'base' as const,
      summary: `${prefix}GPU Pod ${total}개 (요청 ${totalGpuRequested}개${notRunning ? `, NotRunning ${notRunning}` : ''})`,
      data: {
        filters: { search: searchQuery || undefined },
        stats: { total, total_gpu_requested: totalGpuRequested, not_running: notRunning },
        ...summarizeList(pagedPods as unknown as Record<string, unknown>[], {
          total: sortedPods.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace', 'node_name', 'gpu_requested', 'status'],
          filterProblematic: (p) => !/running/i.test((p as unknown as GPUPodInfo).status),
          linkBuilder: (p) => {
            const pod = p as unknown as GPUPodInfo
            return buildResourceLink('Pod', pod.namespace, pod.name)
          },
        }),
      },
    }
  }, [pods, pagedPods, sortedPods.length, currentPage, rowsPerPage, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      await refetch()
    } catch (error) {
      console.error('GPU pods refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  return (
    <div className={`flex flex-col gap-4 ${showCharts ? 'min-h-[calc(100vh-4rem)] overflow-y-auto' : 'h-[calc(100vh-4rem)]'}`}>
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('gpuPods.title', 'GPU Pods')}</h1>
          <p className="mt-2 text-slate-400">{tr('gpuPods.subtitle', 'Pods consuming GPU resources across the cluster.')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCharts((prev) => !prev)}
            className={`btn flex items-center gap-2 ${showCharts ? 'btn-primary' : 'btn-secondary'}`}
          >
            <BarChart3 className="w-4 h-4" />
            {tr('gpuPods.metrics', 'Metrics')}
          </button>
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('gpuPods.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="relative shrink-0">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
        <input
          type="text"
          placeholder={tr('gpuPods.searchPlaceholder', 'Search by pod name, namespace, or node...')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-10 pr-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
        />
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 shrink-0">
        {summaryCards.map(([label, value, boxClass, labelColor]) => (
          <div key={label} className={`rounded-lg border px-3 py-2.5 ${boxClass}`}>
            <div className={`text-[11px] sm:text-xs leading-4 whitespace-nowrap ${labelColor}`}>{label}</div>
            <div className="mt-1 text-lg font-semibold text-white">{value}</div>
          </div>
        ))}
      </div>

      {/* GPU Usage per Node + Status Distribution */}
      {showCharts && (nodeGpuUsage.length > 0 || stats.topStatuses.length > 0) && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 shrink-0">
          {/* GPU usage per node */}
          {nodeGpuUsage.length > 0 && (
            <div className="card">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-white">
                  {tr('gpuPods.nodeUsage', 'GPU Usage by Node')}
                </h2>
                <Box className="w-4 h-4 text-slate-400" />
              </div>
              <div className="space-y-3">
                {nodeGpuUsage.map(([node, info]) => (
                  <div key={node} className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-900/40 px-4 py-2.5">
                    <div>
                      <span className="text-sm font-medium text-white">{node}</span>
                      <span className="ml-2 text-xs text-slate-400">
                        {info.podCount} {info.podCount === 1 ? 'pod' : 'pods'}
                      </span>
                    </div>
                    <span className="text-sm font-semibold text-violet-300">
                      {info.totalGpu} GPU{info.totalGpu !== 1 ? 's' : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Status distribution */}
          {stats.topStatuses.length > 0 && (
            <div className="card">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-white">
                  {tr('gpuPods.statusDistribution', 'Status Distribution')}
                </h2>
              </div>
              <div className="space-y-3">
                {stats.topStatuses.map(([status, count]) => {
                  const pct = stats.total > 0 ? Math.round((count / stats.total) * 100) : 0
                  return (
                    <div key={status}>
                      <div className="flex items-center justify-between text-sm mb-1">
                        <span className="text-slate-300">{status}</span>
                        <span className="text-xs text-slate-400">{count} ({pct}%)</span>
                      </div>
                      <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            status === 'Running' ? 'bg-emerald-500'
                            : status === 'Pending' ? 'bg-yellow-500'
                            : status === 'Succeeded' ? 'bg-blue-500'
                            : status === 'Failed' ? 'bg-red-500'
                            : 'bg-slate-500'
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Table */}
      <div ref={tableContainerRef} className={`card flex flex-col ${showCharts ? 'min-h-[420px]' : 'flex-1 min-h-0'}`}>
        <div ref={tableBodyRef} className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[980px] table-fixed">
            <thead ref={theadRef} className="text-slate-400">
              <tr>
                <th className="text-left py-3 px-4 w-[150px] cursor-pointer" onClick={() => handleSort('namespace')}>
                  <span className="inline-flex items-center gap-1">{tr('gpuPods.table.namespace', 'Namespace')}{renderSortIcon('namespace')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[260px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">{tr('gpuPods.table.name', 'Name')}{renderSortIcon('name')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[200px] cursor-pointer" onClick={() => handleSort('node_name')}>
                  <span className="inline-flex items-center gap-1">{tr('gpuPods.table.node', 'Node')}{renderSortIcon('node_name')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('gpu_requested')}>
                  <span className="inline-flex items-center gap-1">{tr('gpuPods.table.gpus', 'GPUs')}{renderSortIcon('gpu_requested')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[130px] cursor-pointer" onClick={() => handleSort('status')}>
                  <span className="inline-flex items-center gap-1">{tr('gpuPods.table.status', 'Status')}{renderSortIcon('status')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">{tr('gpuPods.table.age', 'Age')}{renderSortIcon('age')}</span>
                </th>
                {metricsAvailable && (
                  <>
                    <th className="text-left py-3 px-4 w-[140px]">
                      {tr('gpuPods.table.gpuUtil', 'GPU Util')}
                    </th>
                    <th className="text-left py-3 px-4 w-[140px]">
                      {tr('gpuPods.table.memUtil', 'Mem Util')}
                    </th>
                  </>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedPods.map((pod, idx) => {
                const podKey = `${pod.namespace}/${pod.name}`
                const podMetric = podMetricsMap.get(podKey)
                return (
                <tr
                      ref={idx === 0 ? firstRowRef : undefined}
                  key={podKey}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({ kind: 'Pod', name: pod.name, namespace: pod.namespace })}
                >
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{pod.namespace}</span></td>
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{pod.name}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{pod.node_name ?? '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{pod.gpu_requested}</td>
                  <td className="py-3 px-4">
                    <span className={`badge ${getStatusColor(pod.status)}`}>{pod.status}</span>
                  </td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(pod.created_at)}</td>
                  {metricsAvailable && (
                    <>
                      <td className="py-3 px-4">
                        {podMetric ? (
                          <div className="flex items-center gap-2">
                            <div className="w-16 h-2 bg-slate-800 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${podMetric.gpu_util >= 80 ? 'bg-red-500' : podMetric.gpu_util >= 50 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                                style={{ width: `${Math.min(podMetric.gpu_util, 100)}%` }}
                              />
                            </div>
                            <span className="text-xs font-mono">{Math.round(podMetric.gpu_util)}%</span>
                          </div>
                        ) : (
                          <span className="text-xs text-slate-500">-</span>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        {podMetric ? (
                          <div className="flex items-center gap-2">
                            <div className="w-16 h-2 bg-slate-800 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${podMetric.memory_util_percent >= 80 ? 'bg-red-500' : podMetric.memory_util_percent >= 50 ? 'bg-amber-500' : 'bg-blue-500'}`}
                                style={{ width: `${Math.min(podMetric.memory_util_percent, 100)}%` }}
                              />
                            </div>
                            <span className="text-xs font-mono">{Math.round(podMetric.memory_util_percent)}%</span>
                          </div>
                        ) : (
                          <span className="text-xs text-slate-500">-</span>
                        )}
                      </td>
                    </>
                  )}
                </tr>
                )
              })}
              {isLoading && (
                <tr>
                  <td colSpan={metricsAvailable ? 8 : 6} className="py-10 px-4 text-center text-slate-400">
                    <div className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading...
                    </div>
                  </td>
                </tr>
              )}
              {sortedPods.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={metricsAvailable ? 8 : 6} className="py-6 px-4 text-center text-slate-400">
                    {tr('gpuPods.noResults', 'No GPU pods found.')}
                  </td>
                </tr>
              )}
            </tbody>
              <AdaptiveTableFillerRows count={rowsPerPage - pagedPods.length} columnCount={8} />
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
    </div>
  )
}
