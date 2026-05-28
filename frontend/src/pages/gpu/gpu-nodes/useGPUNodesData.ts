import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import { useAIContext } from '@/hooks/useAIContext'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import type { GPUDashboardData, GPUMetricsData, GPUDeviceMetric, GPUNodeInfo } from '@/services/api'
import type { SortKey, SummaryCard } from './gpuNodesHelpers'

interface UseGPUNodesDataParams {
  searchQuery: string
  sortKey: SortKey
  sortDir: 'asc' | 'desc'
  currentPage: number
}

export function useGPUNodesData({ searchQuery, sortKey, sortDir, currentPage }: UseGPUNodesDataParams) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })

  const [isRefreshing, setIsRefreshing] = useState(false)

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
