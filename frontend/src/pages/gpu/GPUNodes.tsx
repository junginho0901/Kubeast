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
  Monitor,
  Loader2,
  Search,
  ChevronUp,
  ChevronDown,
  BarChart3,
} from 'lucide-react'

import type { GPUDashboardData, GPUMetricsData, GPUDeviceMetric, GPUNodeInfo } from '@/services/api'

type SortKey = null | 'name' | 'gpu_model' | 'gpu_memory' | 'gpu_capacity' | 'gpu_allocatable' | 'status' | 'mig_strategy'
type SummaryCard = [label: string, value: number | string, boxClass: string, labelClass: string]

export default function GPUNodes() {
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

  // Group metrics by hostname
  const gpusByHost = useMemo(() => {
    if (!metrics?.gpus) return new Map<string, GPUDeviceMetric[]>()
    const map = new Map<string, GPUDeviceMetric[]>()
    for (const gpu of metrics.gpus) {
      const host = gpu.hostname || 'Unknown'
      const list = map.get(host) ?? []
      list.push(gpu)
      map.set(host, list)
    }
    return map
  }, [metrics])

  const nodes = data?.gpu_nodes ?? []

  const filteredNodes = useMemo(() => {
    if (!searchQuery.trim()) return nodes
    const q = searchQuery.toLowerCase()
    return nodes.filter(
      (node) =>
        node.name.toLowerCase().includes(q) ||
        (node.gpu_model ?? '').toLowerCase().includes(q) ||
        (node.driver_version ?? '').toLowerCase().includes(q),
    )
  }, [nodes, searchQuery])

  const stats = useMemo(() => {
    const total = nodes.length
    const ready = nodes.filter((n) => n.status === 'Ready').length
    const notReady = total - ready
    const totalCapacity = nodes.reduce((sum, n) => sum + n.gpu_capacity, 0)
    const totalAllocatable = nodes.reduce((sum, n) => sum + n.gpu_allocatable, 0)
    const totalUsed = data?.total_gpu_used ?? 0
    const migNodes = nodes.filter((n) => n.mig_strategy && n.mig_strategy !== 'none').length
    return { total, ready, notReady, totalCapacity, totalAllocatable, totalUsed, migNodes }
  }, [nodes, data])

  const summaryCards = useMemo<SummaryCard[]>(
    () => [
      [tr('gpuNodes.stats.total', 'Total Nodes'), stats.total, 'border-slate-700 bg-slate-900/50', 'text-slate-400'],
      [tr('gpuNodes.stats.ready', 'Ready'), stats.ready, 'border-emerald-700/40 bg-emerald-900/10', 'text-emerald-300'],
      [tr('gpuNodes.stats.notReady', 'Not Ready'), stats.notReady, 'border-rose-700/40 bg-rose-900/10', 'text-rose-300'],
      [tr('gpuNodes.stats.capacity', 'GPU Capacity'), stats.totalCapacity, 'border-blue-700/40 bg-blue-900/10', 'text-blue-300'],
      [tr('gpuNodes.stats.allocatable', 'Allocatable'), stats.totalAllocatable, 'border-cyan-700/40 bg-cyan-900/10', 'text-cyan-300'],
      [tr('gpuNodes.stats.used', 'Used'), stats.totalUsed, 'border-violet-700/40 bg-violet-900/10', 'text-violet-300'],
    ],
    [stats, tr],
  )

  // GPU model distribution for top section
  const modelDistribution = useMemo(() => {
    const map = new Map<string, { count: number; totalCapacity: number; totalAllocatable: number }>()
    for (const node of nodes) {
      const model = node.gpu_model ?? 'Unknown'
      const entry = map.get(model) ?? { count: 0, totalCapacity: 0, totalAllocatable: 0 }
      entry.count += 1
      entry.totalCapacity += node.gpu_capacity
      entry.totalAllocatable += node.gpu_allocatable
      map.set(model, entry)
    }
    return [...map.entries()]
      .sort((a, b) => b[1].totalCapacity - a[1].totalCapacity)
      .slice(0, 4)
  }, [nodes])

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

  const sortedNodes = useMemo(() => {
    if (!sortKey) return filteredNodes
    const list = [...filteredNodes]
    const getValue = (node: GPUNodeInfo): string | number => {
      switch (sortKey) {
        case 'name': return node.name
        case 'gpu_model': return node.gpu_model ?? ''
        case 'gpu_memory': return node.gpu_memory ?? ''
        case 'gpu_capacity': return node.gpu_capacity
        case 'gpu_allocatable': return node.gpu_allocatable
        case 'status': return node.status
        case 'mig_strategy': return node.mig_strategy ?? ''
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
  }, [filteredNodes, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedNodes.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedNodes.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const pagedNodes = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedNodes.slice(start, start + rowsPerPage)
  }, [sortedNodes, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (nodes.length === 0) return null
    const total = nodes.length
    const totalCapacity = nodes.reduce((s, n) => s + (n.gpu_capacity ?? 0), 0)
    const totalAlloc = nodes.reduce((s, n) => s + (n.gpu_allocatable ?? 0), 0)
    const notReady = nodes.filter((n) => !/ready/i.test(n.status)).length
    const prefix = notReady > 0 ? '⚠️ ' : ''
    return {
      source: 'base' as const,
      summary: `${prefix}GPU 노드 ${total}개 (capacity ${totalCapacity}, allocatable ${totalAlloc}${notReady ? `, NotReady ${notReady}` : ''})`,
      data: {
        filters: { search: searchQuery || undefined },
        stats: { total, total_capacity: totalCapacity, total_allocatable: totalAlloc, not_ready: notReady },
        ...summarizeList(pagedNodes as unknown as Record<string, unknown>[], {
          total: sortedNodes.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'gpu_model', 'gpu_capacity', 'gpu_allocatable', 'status', 'mig_strategy'],
          filterProblematic: (n) => !/ready/i.test((n as unknown as GPUNodeInfo).status),
          linkBuilder: (n) => {
            const node = n as unknown as GPUNodeInfo
            return buildResourceLink('Node', undefined, node.name)
          },
        }),
      },
    }
  }, [nodes, pagedNodes, sortedNodes.length, currentPage, rowsPerPage, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      await refetch()
    } catch (error) {
      console.error('GPU nodes refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const getStatusColor = (status: string) => {
    const lower = status.toLowerCase()
    if (lower === 'ready') return 'badge-success'
    if (lower.includes('notready') || lower.includes('unknown')) return 'badge-error'
    return 'badge-warning'
  }

  return (
    <div className={`flex flex-col gap-4 ${showCharts ? 'min-h-[calc(100vh-4rem)] overflow-y-auto' : 'h-[calc(100vh-4rem)]'}`}>
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('gpuNodes.title', 'GPU Nodes')}</h1>
          <p className="mt-2 text-slate-400">{tr('gpuNodes.subtitle', 'GPU node status, capacity, and model information.')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCharts((prev) => !prev)}
            className={`btn flex items-center gap-2 ${showCharts ? 'btn-primary' : 'btn-secondary'}`}
          >
            <BarChart3 className="w-4 h-4" />
            {tr('gpuNodes.metrics', 'Metrics')}
          </button>
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('gpuNodes.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="relative shrink-0">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
        <input
          type="text"
          placeholder={tr('gpuNodes.searchPlaceholder', 'Search by node name, GPU model, driver version...')}
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

      {/* GPU Model Distribution */}
      {showCharts && modelDistribution.length > 0 && (
        <div className="card shrink-0">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-white">
              {tr('gpuNodes.modelDistribution', 'GPU Model Distribution')}
            </h2>
            <Monitor className="w-4 h-4 text-slate-400" />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
            {modelDistribution.map(([model, info]) => {
              const utilization = info.totalAllocatable > 0
                ? Math.round(((info.totalCapacity - info.totalAllocatable) / info.totalCapacity) * 100)
                : 0
              return (
                <div key={model} className="rounded-lg border border-slate-700 bg-slate-900/40 px-4 py-3">
                  <div className="flex items-center justify-between text-sm text-white">
                    <span className="font-medium truncate">{model}</span>
                    <span className="text-xs text-slate-400 ml-2 whitespace-nowrap">
                      {info.count} {info.count === 1 ? 'node' : 'nodes'}
                    </span>
                  </div>
                  <div className="mt-3 space-y-2">
                    <div className="text-xs text-slate-400 flex items-center justify-between">
                      <span>{tr('gpuNodes.capacity', 'Capacity')}</span>
                      <span className="font-medium text-blue-300">{info.totalCapacity}</span>
                    </div>
                    <div className="text-xs text-slate-400 flex items-center justify-between">
                      <span>{tr('gpuNodes.allocatable', 'Allocatable')}</span>
                      <span className="font-medium text-cyan-300">{info.totalAllocatable}</span>
                    </div>
                    <div className="w-full h-2.5 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${utilization >= 80 ? 'bg-red-500' : utilization >= 60 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                        style={{ width: `${Math.min(utilization, 100)}%` }}
                      />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Real-time GPU Metrics per Node */}
      {showCharts && metricsAvailable && gpusByHost.size > 0 && (
        <div className="card shrink-0">
          <div className="flex items-center gap-2 mb-4">
            <div className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
            <h2 className="text-sm font-semibold text-white">
              {tr('gpuNodes.realtimeMetrics', 'Real-time GPU Utilization')}
            </h2>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {[...gpusByHost.entries()].map(([hostname, gpus]) => {
              const avgUtil = gpus.reduce((s, g) => s + g.gpu_util, 0) / gpus.length
              const avgMem = gpus.reduce((s, g) => s + g.memory_util_percent, 0) / gpus.length
              return (
                <div key={hostname} className="rounded-lg border border-slate-700 bg-slate-900/40 px-4 py-3">
                  <div className="flex items-center justify-between text-sm text-white mb-3">
                    <span className="font-medium">{hostname}</span>
                    <span className="text-xs text-slate-400">{gpus.length} GPU{gpus.length !== 1 ? 's' : ''}</span>
                  </div>
                  <div className="space-y-2">
                    {gpus.map((gpu) => (
                      <div key={gpu.uuid} className="flex items-center gap-3">
                        <span className="text-xs text-slate-400 w-16 shrink-0">GPU {gpu.gpu}</span>
                        <div className="flex-1 space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-slate-500 w-7">Core</span>
                            <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${gpu.gpu_util >= 80 ? 'bg-red-500' : gpu.gpu_util >= 50 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                                style={{ width: `${Math.min(gpu.gpu_util, 100)}%` }}
                              />
                            </div>
                            <span className="text-[10px] font-mono text-slate-300 w-10 text-right">{Math.round(gpu.gpu_util)}%</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-slate-500 w-7">Mem</span>
                            <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${gpu.memory_util_percent >= 80 ? 'bg-red-500' : gpu.memory_util_percent >= 50 ? 'bg-amber-500' : 'bg-blue-500'}`}
                                style={{ width: `${Math.min(gpu.memory_util_percent, 100)}%` }}
                              />
                            </div>
                            <span className="text-[10px] font-mono text-slate-300 w-10 text-right">{Math.round(gpu.memory_util_percent)}%</span>
                          </div>
                        </div>
                        {gpu.memory_temp > 0 && (
                          <span className={`text-[10px] w-10 text-right ${gpu.memory_temp >= 85 ? 'text-red-400' : gpu.memory_temp >= 70 ? 'text-amber-400' : 'text-slate-400'}`}>
                            {gpu.memory_temp}°C
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 pt-2 border-t border-slate-700/50 flex gap-4 text-[10px] text-slate-500">
                    <span>Avg Core: {Math.round(avgUtil)}%</span>
                    <span>Avg Mem: {Math.round(avgMem)}%</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Table */}
      <div ref={tableContainerRef} className={`card flex flex-col ${showCharts ? 'min-h-[420px]' : 'flex-1 min-h-0'}`}>
        <div ref={tableBodyRef} className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[980px] table-fixed">
            <thead ref={theadRef} className="text-slate-400">
              <tr>
                <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">{tr('gpuNodes.table.name', 'Name')}{renderSortIcon('name')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[200px] cursor-pointer" onClick={() => handleSort('gpu_model')}>
                  <span className="inline-flex items-center gap-1">{tr('gpuNodes.table.gpuModel', 'GPU Model')}{renderSortIcon('gpu_model')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('gpu_memory')}>
                  <span className="inline-flex items-center gap-1">{tr('gpuNodes.table.gpuMemory', 'GPU Memory')}{renderSortIcon('gpu_memory')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[110px] cursor-pointer" onClick={() => handleSort('gpu_capacity')}>
                  <span className="inline-flex items-center gap-1">{tr('gpuNodes.table.capacity', 'Capacity')}{renderSortIcon('gpu_capacity')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('gpu_allocatable')}>
                  <span className="inline-flex items-center gap-1">{tr('gpuNodes.table.allocatable', 'Allocatable')}{renderSortIcon('gpu_allocatable')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[110px] cursor-pointer" onClick={() => handleSort('status')}>
                  <span className="inline-flex items-center gap-1">{tr('gpuNodes.table.status', 'Status')}{renderSortIcon('status')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[130px] cursor-pointer" onClick={() => handleSort('mig_strategy')}>
                  <span className="inline-flex items-center gap-1">{tr('gpuNodes.table.migStrategy', 'MIG Strategy')}{renderSortIcon('mig_strategy')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedNodes.map((node, idx) => (
                <tr
                      ref={idx === 0 ? firstRowRef : undefined}
                  key={node.name}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({ kind: 'Node', name: node.name })}
                >
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{node.name}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{node.gpu_model ?? '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{node.gpu_memory ?? '-'}</td>
                  <td className="py-3 px-4 text-xs font-mono">{node.gpu_capacity}</td>
                  <td className="py-3 px-4 text-xs font-mono">{node.gpu_allocatable}</td>
                  <td className="py-3 px-4">
                    <span className={`badge ${getStatusColor(node.status)}`}>{node.status}</span>
                  </td>
                  <td className="py-3 px-4 text-xs font-mono">{node.mig_strategy ?? '-'}</td>
                </tr>
              ))}
              {isLoading && (
                <tr>
                  <td colSpan={7} className="py-10 px-4 text-center text-slate-400">
                    <div className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading...
                    </div>
                  </td>
                </tr>
              )}
              {sortedNodes.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={7} className="py-6 px-4 text-center text-slate-400">
                    {tr('gpuNodes.noResults', 'No GPU nodes found.')}
                  </td>
                </tr>
              )}
            </tbody>
              <AdaptiveTableFillerRows count={rowsPerPage - pagedNodes.length} columnCount={7} />
          </table>
        </div>
        {sortedNodes.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedNodes.length),
                total: sortedNodes.length,
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
