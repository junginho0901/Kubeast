import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { useAIContext } from '@/hooks/useAIContext'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import { RefreshCw, BarChart3 } from 'lucide-react'

import type { GPUDashboardData, GPUMetricsData, GPUPodInfo } from '@/services/api'
import { parseAgeSeconds, type SortKey, type SummaryCard } from './gpupods/gpuPodsHelpers'
import { GPUPodsFilters } from './gpupods/GPUPodsFilters'
import { GPUPodsTable } from './gpupods/GPUPodsTable'
import { GPUPodsCharts } from './gpupods/GPUPodsCharts'

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

      <GPUPodsFilters
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        searchPlaceholder={tr('gpuPods.searchPlaceholder', 'Search by pod name, namespace, or node...')}
      />

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 shrink-0">
        {summaryCards.map(([label, value, boxClass, labelColor]) => (
          <div key={label} className={`rounded-lg border px-3 py-2.5 ${boxClass}`}>
            <div className={`text-[11px] sm:text-xs leading-4 whitespace-nowrap ${labelColor}`}>{label}</div>
            <div className="mt-1 text-lg font-semibold text-white">{value}</div>
          </div>
        ))}
      </div>

      {showCharts && (
        <GPUPodsCharts
          nodeGpuUsage={nodeGpuUsage}
          topStatuses={stats.topStatuses}
          total={stats.total}
          tr={tr}
        />
      )}

      <GPUPodsTable
        pagedPods={pagedPods}
        sortedPodsLength={sortedPods.length}
        isLoading={isLoading}
        metricsAvailable={metricsAvailable}
        podMetricsMap={podMetricsMap}
        showCharts={showCharts}
        sortKey={sortKey}
        setSortKey={setSortKey}
        sortDir={sortDir}
        setSortDir={setSortDir}
        currentPage={currentPage}
        setCurrentPage={setCurrentPage}
        totalPages={totalPages}
        rowsPerPage={rowsPerPage}
        tableContainerRef={tableContainerRef}
        tableBodyRef={tableBodyRef}
        theadRef={theadRef}
        firstRowRef={firstRowRef}
        openDetail={openDetail}
        tr={tr}
      />
    </div>
  )
}
