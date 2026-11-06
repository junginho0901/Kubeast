import { useEffect, useMemo, useState, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, isForbiddenError } from '@/services/api'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { useAIContext } from '@/hooks/useAIContext'
import { usePermission } from '@/hooks/usePermission'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import { RefreshCw, BarChart3, ChevronDown, ChevronUp } from 'lucide-react'

import type { GPUDashboardData, GPUMetricsData, GPUPodInfo } from '@/services/api'
import { parseAgeSeconds, type SortKey, type SummaryCard } from './gpupods/gpuPodsHelpers'
import { GPUPodsFilters } from './gpupods/GPUPodsFilters'
import { GPUPodsTable } from './gpupods/GPUPodsTable'
import { GPUPodsCharts } from './gpupods/GPUPodsCharts'
import { gpuPodCounts, gpuPodStatuses, gpuPodsByNode, gpuPodVendorCounts, podGpuUsage, vendorNames } from './gpuNumbers'

export default function GPUPods() {
  const { t } = useTranslation()
  const tr = useCallback((key: string, fallback: string, options?: Record<string, any>) => t(key, { defaultValue: fallback, ...options }), [t])
  const { open: openDetail } = useResourceDetail()

  const [searchQuery, setSearchQuery] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [currentPage, setCurrentPage] = useState(1)
  const [showCharts, setShowCharts] = useState(false)

  // A grant limited to namespaces lists its own pods: it may not list nodes, and the cluster's GPU metrics are refused
  // to it whatever it holds (k8s-service promClusterWide).
  const limited = !!usePermission().clusterNamespaces?.length
  const { data, isLoading, error, refetch } = useQuery<GPUDashboardData>({
    queryKey: limited ? ['gpu', 'dashboard', 'pods'] : ['gpu', 'dashboard'],
    queryFn: () => api.getGPUDashboard(limited),
    refetchInterval: 30000,
    retry: 2,
    retryDelay: 1000,
  })

  const { data: metrics } = useQuery<GPUMetricsData>({
    queryKey: ['gpu', 'metrics'],
    queryFn: () => api.getGPUMetrics(),
    enabled: !limited,
    refetchInterval: 15000,
    retry: 1,
  })

  const metricsAvailable = metrics?.available ?? false

  // Build pod→GPU metrics lookup (every GPU of a pod, not the last one seen)
  const podMetricsMap = useMemo(() => podGpuUsage(metrics?.gpus), [metrics])
  // the cluster refused the list (a grant limited to namespaces): the cards count nothing
  const forbidden = isForbiddenError(error)

  const pods = useMemo(() => data?.gpu_pods ?? [], [data?.gpu_pods])

  const filteredPods = useMemo(() => {
    if (!searchQuery.trim()) return pods
    const q = searchQuery.toLowerCase()
    return pods.filter(
      (pod) =>
        pod.name.toLowerCase().includes(q) ||
        pod.namespace.toLowerCase().includes(q) ||
        (pod.node_name ?? '').toLowerCase().includes(q) ||
        vendorNames(pod.gpu_vendors).toLowerCase().includes(q),
    )
  }, [pods, searchQuery])

  const stats = useMemo(() => {
    const { total, running, pending, failed, requested: totalGpuRequested, namespaces } = gpuPodCounts(pods)
    // Status distribution: every status
    return { total, running, pending, failed, totalGpuRequested, namespaces, topStatuses: gpuPodStatuses(pods) }
  }, [pods])

  const summaryCards = useMemo<SummaryCard[]>(
    () => {
      const n = (v: number) => (forbidden ? '-' : v)
      return [
        [tr('gpuPods.stats.total', 'Total Pods'), n(stats.total), 'border-slate-700 bg-slate-900/50', 'text-slate-400'],
        [tr('gpuPods.stats.running', 'Running'), n(stats.running), 'border-emerald-700/40 bg-emerald-900/10', 'text-emerald-300'],
        [tr('gpuPods.stats.pending', 'Pending'), n(stats.pending), 'border-yellow-700/40 bg-yellow-900/10', 'text-yellow-300'],
        [tr('gpuPods.stats.failed', 'Failed'), n(stats.failed), 'border-rose-700/40 bg-rose-900/10', 'text-rose-300'],
        [tr('gpuPods.stats.gpuRequested', 'GPUs Requested'), n(stats.totalGpuRequested), 'border-slate-700 bg-slate-900/50', 'text-slate-400'],
        [tr('gpuPods.stats.namespaces', 'Namespaces'), n(stats.namespaces), 'border-slate-700 bg-slate-900/50', 'text-slate-400'],
      ]
    },
    [stats, tr, forbidden],
  )

  // GPU usage per node: every node
  const nodeGpuUsage = useMemo(() => gpuPodsByNode(pods), [pods])

  const sortedPods = useMemo(() => {
    if (!sortKey) return filteredPods
    const list = [...filteredPods]
    const getValue = (pod: GPUPodInfo): string | number => {
      switch (sortKey) {
        case 'namespace': return pod.namespace
        case 'name': return pod.name
        case 'node_name': return pod.node_name || ''
        case 'gpu_requested': return pod.gpu_requested
        case 'gpu_vendor': return vendorNames(pod.gpu_vendors)
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
    if (!data) return null
    const total = pods.length
    const { requested: totalGpuRequested } = gpuPodCounts(pods)
    const notRunning = pods.filter((p) => p.phase !== 'Running').length
    const prefix = notRunning > 0 ? '⚠️ ' : ''
    return {
      source: 'base' as const,
      summary: `${prefix}GPU Pod ${total}개 (요청 ${totalGpuRequested}개${notRunning ? `, NotRunning ${notRunning}` : ''})`,
      data: {
        filters: { search: searchQuery || undefined },
        // each company's pods and the GPUs they still ask for; the charts' statuses and nodes, every one
        stats: {
          total, total_gpu_requested: totalGpuRequested, not_running: notRunning, by_vendor: gpuPodVendorCounts(pods),
          by_status: stats.topStatuses.map(([status, n]) => ({ status, pods: n })),
          by_node: nodeGpuUsage.map(([node, e]) => ({ node: node || null, pods: e.podCount, gpus: e.totalGpu })),
        },
        ...summarizeList(pagedPods as unknown as Record<string, unknown>[], {
          total: sortedPods.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace', 'node_name', 'gpu_requested', 'gpu_vendors', 'status'],
          filterProblematic: (p) => (p as unknown as GPUPodInfo).phase !== 'Running',
          linkBuilder: (p) => {
            const pod = p as unknown as GPUPodInfo
            return buildResourceLink('Pod', pod.namespace, pod.name)
          },
        }),
      },
    }
  }, [data, pods, stats, nodeGpuUsage, pagedPods, sortedPods.length, currentPage, rowsPerPage, searchQuery])

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
      <div className="page-head items-center shrink-0">
        <div>
          <h1 className="text-3xl font-semibold text-ink">{tr('gpuPods.title', 'GPU Pods')}</h1>
          <p className="mt-2 text-slate-400">{tr('gpuPods.subtitle', 'Pods consuming GPU resources across the cluster.')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCharts((prev) => !prev)}
            aria-pressed={showCharts}
            className="btn btn-primary flex items-center gap-2"
          >
            <BarChart3 className="w-4 h-4" />
            {tr('gpuPods.metrics', 'Metrics')}
            {showCharts ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
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
        searchPlaceholder={tr('gpuPods.searchPlaceholder', 'Search by pod name, namespace, node, or vendor...')}
      />

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 shrink-0">
        {summaryCards.map(([label, value, boxClass, labelColor]) => (
          <div key={label} className={`rounded-lg border px-3 py-2.5 ${boxClass}`}>
            <div className={`text-[11px] sm:text-xs leading-4 whitespace-nowrap ${labelColor}`}>{label}</div>
            <div className="mt-1 text-lg font-semibold text-ink">{value}</div>
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
        searching={!!searchQuery.trim()}
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
