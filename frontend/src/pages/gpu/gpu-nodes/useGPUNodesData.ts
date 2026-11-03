import { useMemo, useState, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, isForbiddenError } from '@/services/api'
import { useAIContext } from '@/hooks/useAIContext'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import type { GPUDashboardData, GPUMetricsData, GPUDeviceMetric, GPUNodeInfo } from '@/services/api'
import type { SortKey, SummaryCard } from './gpuNodesHelpers'
import { gpuNodeCounts } from '../gpuNumbers'
import { nodeReadiness } from '@/utils/nodeStatus'

interface UseGPUNodesDataParams {
  searchQuery: string
  sortKey: SortKey
  sortDir: 'asc' | 'desc'
  currentPage: number
}

export function useGPUNodesData({ searchQuery, sortKey, sortDir, currentPage }: UseGPUNodesDataParams) {
  const { t } = useTranslation()
  const tr = useCallback((key: string, fallback: string, options?: Record<string, any>) => t(key, { defaultValue: fallback, ...options }), [t])

  const [isRefreshing, setIsRefreshing] = useState(false)

  const { data, isLoading, error, refetch } = useQuery<GPUDashboardData>({
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

  const nodes = useMemo(() => data?.gpu_nodes ?? [], [data?.gpu_nodes])

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

  // the cluster refused the list (a grant limited to namespaces): the cards count nothing
  const forbidden = isForbiddenError(error)

  const stats = useMemo(() => {
    // Ready as kubectl's STATUS starts (a cordoned node is Ready,SchedulingDisabled); Not Ready is every other node
    const { total, ready, notReady } = gpuNodeCounts(nodes)
    const totalCapacity = nodes.reduce((sum, n) => sum + n.gpu_capacity, 0)
    const totalAllocatable = nodes.reduce((sum, n) => sum + n.gpu_allocatable, 0)
    const totalUsed = data?.total_gpu_used ?? 0
    const migNodes = nodes.filter((n) => n.mig_strategy && n.mig_strategy !== 'none').length
    return { total, ready, notReady, totalCapacity, totalAllocatable, totalUsed, migNodes }
  }, [nodes, data])

  const summaryCards = useMemo<SummaryCard[]>(
    () => {
      const n = (v: number) => (forbidden ? '-' : v)
      return [
        [tr('gpuNodes.stats.total', 'Total Nodes'), n(stats.total), 'border-slate-700 bg-slate-900/50', 'text-slate-400'],
        [tr('gpuNodes.stats.ready', 'Ready'), n(stats.ready), 'border-emerald-700/40 bg-emerald-900/10', 'text-emerald-300'],
        [tr('gpuNodes.stats.notReady', 'Not Ready'), n(stats.notReady), 'border-rose-700/40 bg-rose-900/10', 'text-rose-300'],
        [tr('gpuNodes.stats.capacity', 'GPU Capacity'), n(stats.totalCapacity), 'border-slate-700 bg-slate-900/50', 'text-slate-400'],
        [tr('gpuNodes.stats.allocatable', 'Allocatable'), n(stats.totalAllocatable), 'border-slate-700 bg-slate-900/50', 'text-slate-400'],
        [tr('gpuNodes.stats.used', 'Used'), n(stats.totalUsed), 'border-slate-700 bg-slate-900/50', 'text-slate-400'],
      ]
    },
    [stats, tr, forbidden],
  )

  // every model, its nodes' capacity, allocatable and GPUs in use (kubectl describe node's Allocated resources)
  const modelDistribution = useMemo(() => {
    const map = new Map<string, { count: number; totalCapacity: number; totalAllocatable: number; totalUsed: number }>()
    for (const node of nodes) {
      const model = node.gpu_model ?? 'Unknown'
      const entry = map.get(model) ?? { count: 0, totalCapacity: 0, totalAllocatable: 0, totalUsed: 0 }
      entry.count += 1
      entry.totalCapacity += node.gpu_capacity
      entry.totalAllocatable += node.gpu_allocatable
      entry.totalUsed += node.gpu_used ?? 0
      map.set(model, entry)
    }
    return [...map.entries()]
      .sort((a, b) => b[1].totalCapacity - a[1].totalCapacity)
  }, [nodes])

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

  const adaptive = useAdaptiveTable({
    recalculationKey: sortedNodes.length,
  })
  const { rowsPerPage } = adaptive

  const totalPages = Math.max(1, Math.ceil(sortedNodes.length / Math.max(rowsPerPage, 1)))

  const pagedNodes = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedNodes.slice(start, start + rowsPerPage)
  }, [sortedNodes, currentPage, rowsPerPage])

  const aiSnapshot = useMemo(() => {
    if (!data) return null
    const total = nodes.length
    const totalCapacity = nodes.reduce((s, n) => s + (n.gpu_capacity ?? 0), 0)
    const totalAlloc = nodes.reduce((s, n) => s + (n.gpu_allocatable ?? 0), 0)
    const { ready, notReady } = gpuNodeCounts(nodes)
    const prefix = notReady > 0 ? '⚠️ ' : ''
    return {
      source: 'base' as const,
      summary: `${prefix}GPU 노드 ${total}개 (capacity ${totalCapacity}, allocatable ${totalAlloc}${notReady ? `, NotReady ${notReady}` : ''})`,
      data: {
        filters: { search: searchQuery || undefined },
        stats: { total, ready, not_ready: notReady, total_capacity: totalCapacity, total_allocatable: totalAlloc, total_used: data.total_gpu_used },
        ...summarizeList(pagedNodes as unknown as Record<string, unknown>[], {
          total: sortedNodes.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'gpu_model', 'gpu_capacity', 'gpu_allocatable', 'gpu_used', 'status', 'mig_strategy'],
          filterProblematic: (n) => nodeReadiness((n as unknown as GPUNodeInfo).status) !== 'Ready',
          linkBuilder: (n) => {
            const node = n as unknown as GPUNodeInfo
            return buildResourceLink('Node', undefined, node.name)
          },
        }),
      },
    }
  }, [data, nodes, pagedNodes, sortedNodes.length, currentPage, rowsPerPage, searchQuery])

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

  return {
    isLoading,
    isRefreshing,
    handleRefresh,
    metricsAvailable,
    gpusByHost,
    summaryCards,
    modelDistribution,
    sortedNodes,
    pagedNodes,
    rowsPerPage,
    totalPages,
    tableContainerRef: adaptive.containerRef,
    tableBodyRef: adaptive.bodyRef,
    theadRef: adaptive.theadRef,
    firstRowRef: adaptive.firstRowRef,
  }
}
