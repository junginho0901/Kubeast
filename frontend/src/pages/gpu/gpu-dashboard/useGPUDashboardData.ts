// GPUDashboard 의 데이터 fetching + 파생 계산 묶음 hook.
//
// 추출 출처: GPUDashboard.tsx (Phase 4.11) — useQuery × 2 (gpu/dashboard,
// gpu/metrics) + useMemo × 7 (gpusByHost / allocationRate / devicePluginHealthy
// / nodeAllocation / modelDistribution / podStatusDist / recentPods).
// 본체는 destructuring 한 번으로 모든 파생 값을 받고 JSX orchestration 만 담당.

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import type { GPUDashboardData, GPUMetricsData, GPUDeviceMetric } from '@/services/api'

export function useGPUDashboardData() {
  const { data, isLoading, isError, refetch } = useQuery<GPUDashboardData>({
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
    retryDelay: 2000,
  })

  const metricsAvailable = metrics?.available ?? false

  // Per-GPU metrics grouped by hostname
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

  const allocationRate = useMemo(() => {
    if (!data || data.total_gpu_allocatable === 0) return 0
    return Math.round((data.total_gpu_used / data.total_gpu_allocatable) * 100)
  }, [data])

  const devicePluginHealthy = useMemo(() => {
    if (!data?.device_plugin_status) return false
    return data.device_plugin_status.ready >= data.device_plugin_status.desired
  }, [data])

  // Per-node GPU allocation bars
  const nodeAllocation = useMemo(() => {
    if (!data) return []
    const nodes = data.gpu_nodes
    // Count GPU usage per node from pods
    const usedMap = new Map<string, number>()
    for (const pod of data.gpu_pods) {
      const node = pod.node_name ?? ''
      if (node) usedMap.set(node, (usedMap.get(node) || 0) + pod.gpu_requested)
    }
    return nodes.map((node) => ({
      ...node,
      gpu_used: usedMap.get(node.name) ?? 0,
    })).sort((a, b) => b.gpu_capacity - a.gpu_capacity)
  }, [data])

  // GPU model distribution
  const modelDistribution = useMemo(() => {
    if (!data) return []
    const map = new Map<string, number>()
    for (const node of data.gpu_nodes) {
      const model = node.gpu_model ?? 'Unknown'
      map.set(model, (map.get(model) || 0) + node.gpu_capacity)
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1])
  }, [data])

  // Pod status distribution
  const podStatusDist = useMemo(() => {
    if (!data) return []
    const map = new Map<string, number>()
    for (const pod of data.gpu_pods) {
      map.set(pod.status, (map.get(pod.status) || 0) + 1)
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1])
  }, [data])

  // Recent pods (latest 5)
  const recentPods = useMemo(() => {
    if (!data) return []
    return [...data.gpu_pods]
      .sort((a, b) => {
        const ta = a.created_at ? new Date(a.created_at).getTime() : 0
        const tb = b.created_at ? new Date(b.created_at).getTime() : 0
        return tb - ta
      })
      .slice(0, 5)
  }, [data])

  return {
    data,
    metrics,
    metricsAvailable,
    gpusByHost,
    allocationRate,
    devicePluginHealthy,
    nodeAllocation,
    modelDistribution,
    podStatusDist,
    recentPods,
    isLoading,
    isError,
    refetch,
  }
}
