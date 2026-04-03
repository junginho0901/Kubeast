import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { api } from '@/services/api'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import {
  RefreshCw,
  Monitor,
  Cpu,
  Activity,
  Gauge,
  CheckCircle,
  XCircle,
  Server,
  Box,
  ArrowRight,
} from 'lucide-react'

import type { GPUDashboardData, GPUMetricsData, GPUDeviceMetric, GPUPodInfo } from '@/services/api'

function formatAge(createdAt?: string | null): string {
  if (!createdAt) return '-'
  const sec = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000))
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function StatusBadge({ enabled, label }: { enabled: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
        enabled
          ? 'bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20'
          : 'bg-slate-500/10 text-slate-400 ring-1 ring-slate-500/20'
      }`}
    >
      {enabled ? <CheckCircle className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
      {label}
    </span>
  )
}

function SkeletonCard() {
  return (
    <div className="animate-pulse rounded-xl border border-slate-700/50 bg-slate-800/50 p-5">
      <div className="mb-3 h-4 w-24 rounded bg-slate-700" />
      <div className="h-8 w-16 rounded bg-slate-700" />
    </div>
  )
}

function getStatusColor(status: string): string {
  const lower = (status || '').toLowerCase()
  if (lower === 'running' || lower === 'succeeded' || lower === 'completed' || lower === 'ready') return 'badge-success'
  if (lower === 'pending') return 'badge-warning'
  if (lower === 'failed' || lower.includes('error') || lower.includes('backoff') || lower.includes('notready')) return 'badge-error'
  return 'badge-info'
}

export default function GPUDashboard() {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback })
  const { open: openDetail } = useResourceDetail()

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

  // Loading state
  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <div className="h-8 w-48 animate-pulse rounded bg-slate-700" />
            <div className="mt-2 h-4 w-72 animate-pulse rounded bg-slate-700" />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    )
  }

  // Error state
  if (isError) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
              {tr('gpuDashboardPage.title', 'GPU Dashboard')}
            </h1>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {tr('gpuDashboardPage.subtitle', 'GPU resource overview across the cluster')}
            </p>
          </div>
          <button
            onClick={() => refetch()}
            className="rounded-lg border border-slate-700 bg-slate-800 p-2 text-slate-300 transition-colors hover:bg-slate-700 hover:text-white"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-col items-center justify-center rounded-xl border border-red-500/20 bg-red-500/5 py-24">
          <XCircle className="mb-4 h-12 w-12 text-red-400" />
          <p className="text-lg text-red-300">
            {tr('gpuDashboardPage.error', 'Failed to load GPU data. The cluster may be temporarily unreachable.')}
          </p>
          <button
            onClick={() => refetch()}
            className="mt-4 rounded-lg bg-slate-700 px-4 py-2 text-sm text-white hover:bg-slate-600"
          >
            {tr('gpuDashboardPage.retry', 'Retry')}
          </button>
        </div>
      </div>
    )
  }

  // Empty state
  if (!data || data.total_gpu_capacity === 0) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
              {tr('gpuDashboardPage.title', 'GPU Dashboard')}
            </h1>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {tr('gpuDashboardPage.subtitle', 'GPU resource overview across the cluster')}
            </p>
          </div>
          <button
            onClick={() => refetch()}
            className="rounded-lg border border-slate-700 bg-slate-800 p-2 text-slate-300 transition-colors hover:bg-slate-700 hover:text-white"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-col items-center justify-center rounded-xl border border-slate-700/50 bg-slate-800/30 py-24">
          <Monitor className="mb-4 h-12 w-12 text-slate-600" />
          <p className="text-lg text-slate-400">
            {tr('gpuDashboardPage.empty', 'No GPU resources detected in this cluster.')}
          </p>
        </div>
      </div>
    )
  }

  const summaryCards = [
    {
      label: tr('gpuDashboardPage.summary.capacity', 'Total Capacity'),
      value: data.total_gpu_capacity,
      icon: Monitor,
      border: 'border-blue-500/30',
      iconBg: 'bg-blue-500/10',
      iconColor: 'text-blue-400',
    },
    {
      label: tr('gpuDashboardPage.summary.allocatable', 'Allocatable'),
      value: data.total_gpu_allocatable,
      icon: Cpu,
      border: 'border-cyan-500/30',
      iconBg: 'bg-cyan-500/10',
      iconColor: 'text-cyan-400',
    },
    {
      label: tr('gpuDashboardPage.summary.used', 'Used'),
      value: data.total_gpu_used,
      icon: Activity,
      border: 'border-violet-500/30',
      iconBg: 'bg-violet-500/10',
      iconColor: 'text-violet-400',
    },
    {
      label: tr('gpuDashboardPage.summary.allocationRate', 'Allocation Rate'),
      value: `${allocationRate}%`,
      icon: Gauge,
      border: allocationRate > 80 ? 'border-amber-500/30' : 'border-emerald-500/30',
      iconBg: allocationRate > 80 ? 'bg-amber-500/10' : 'bg-emerald-500/10',
      iconColor: allocationRate > 80 ? 'text-amber-400' : 'text-emerald-400',
      bar: true,
    },
  ]

  const nodeReadyCount = data.gpu_nodes.filter((n) => n.status === 'Ready').length
  const nodeNotReadyCount = data.gpu_nodes.length - nodeReadyCount

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            {tr('gpuDashboardPage.title', 'GPU Dashboard')}
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {tr('gpuDashboardPage.subtitle', 'GPU resource overview across the cluster')}
          </p>
        </div>
        <button
          onClick={() => refetch()}
          className="rounded-lg border border-slate-700 bg-slate-800 p-2 text-slate-300 transition-colors hover:bg-slate-700 hover:text-white"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {summaryCards.map((card) => {
          const Icon = card.icon
          return (
            <div
              key={card.label}
              className={`rounded-xl border ${card.border} bg-slate-800/50 p-5 transition-colors hover:bg-slate-800/80`}
            >
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-slate-400">{card.label}</p>
                <div className={`rounded-lg p-2 ${card.iconBg}`}>
                  <Icon className={`h-4 w-4 ${card.iconColor}`} />
                </div>
              </div>
              <p className="mt-2 text-3xl font-bold text-white">{card.value}</p>
              {card.bar && (
                <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-700">
                  <div
                    className={`h-full rounded-full transition-all ${
                      allocationRate > 80
                        ? 'bg-amber-500'
                        : allocationRate > 50
                          ? 'bg-cyan-500'
                          : 'bg-emerald-500'
                    }`}
                    style={{ width: `${Math.min(allocationRate, 100)}%` }}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Status Badges */}
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge
          enabled={devicePluginHealthy}
          label={
            devicePluginHealthy
              ? tr('gpuDashboardPage.status.pluginHealthy', 'Device Plugin Healthy')
              : tr('gpuDashboardPage.status.pluginUnhealthy', 'Device Plugin Unhealthy')
          }
        />
        <StatusBadge
          enabled={data.mig_enabled}
          label={
            data.mig_enabled
              ? tr('gpuDashboardPage.status.migEnabled', 'MIG Enabled')
              : tr('gpuDashboardPage.status.migDisabled', 'MIG Disabled')
          }
        />
        <StatusBadge
          enabled={data.time_slicing_enabled}
          label={
            data.time_slicing_enabled
              ? tr('gpuDashboardPage.status.timeSlicingEnabled', 'Time-Slicing Enabled')
              : tr('gpuDashboardPage.status.timeSlicingDisabled', 'Time-Slicing Disabled')
          }
        />
        {data.device_plugin_status && (
          <span className="text-xs text-slate-500">
            {tr('gpuDashboardPage.status.pluginDetail', 'Plugin')}: {data.device_plugin_status.ready}/{data.device_plugin_status.desired}{' '}
            {tr('gpuDashboardPage.status.ready', 'ready')}
          </span>
        )}
      </div>

      {/* Real-time GPU Metrics (from Prometheus/DCGM) */}
      {metricsAvailable && metrics && (
        <div className="rounded-xl border border-slate-700/50 bg-slate-800/30 p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-emerald-400" />
              <h2 className="text-sm font-semibold text-white">
                {tr('gpuDashboardPage.realtime.title', 'Real-time GPU Metrics')}
              </h2>
              <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-400 ring-1 ring-emerald-500/20">
                Live
              </span>
            </div>
            <span className="text-xs text-slate-500">
              {metrics.gpu_count} GPU{metrics.gpu_count !== 1 ? 's' : ''} detected
            </span>
          </div>

          {/* Avg metrics summary */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <div className="rounded-lg border border-slate-700/50 bg-slate-900/40 px-3 py-2.5">
              <div className="text-[11px] text-slate-400">{tr('gpuDashboardPage.realtime.avgUtil', 'Avg GPU Utilization')}</div>
              <div className="mt-1 text-lg font-semibold text-white">{Math.round(metrics.avg_gpu_util)}%</div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                <div
                  className={`h-full rounded-full ${metrics.avg_gpu_util >= 80 ? 'bg-red-500' : metrics.avg_gpu_util >= 50 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                  style={{ width: `${Math.min(metrics.avg_gpu_util, 100)}%` }}
                />
              </div>
            </div>
            <div className="rounded-lg border border-slate-700/50 bg-slate-900/40 px-3 py-2.5">
              <div className="text-[11px] text-slate-400">{tr('gpuDashboardPage.realtime.avgMemUtil', 'Avg Memory Utilization')}</div>
              <div className="mt-1 text-lg font-semibold text-white">{Math.round(metrics.avg_memory_util)}%</div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                <div
                  className={`h-full rounded-full ${metrics.avg_memory_util >= 80 ? 'bg-red-500' : metrics.avg_memory_util >= 50 ? 'bg-amber-500' : 'bg-blue-500'}`}
                  style={{ width: `${Math.min(metrics.avg_memory_util, 100)}%` }}
                />
              </div>
            </div>
            <div className="rounded-lg border border-slate-700/50 bg-slate-900/40 px-3 py-2.5">
              <div className="text-[11px] text-slate-400">{tr('gpuDashboardPage.realtime.memUsed', 'Memory Used')}</div>
              <div className="mt-1 text-lg font-semibold text-white">
                {metrics.total_memory_mb > 0 ? `${(metrics.total_memory_used_mb / 1024).toFixed(1)} GiB` : '-'}
              </div>
              <div className="text-[11px] text-slate-500">
                / {(metrics.total_memory_mb / 1024).toFixed(1)} GiB
              </div>
            </div>
            <div className="rounded-lg border border-slate-700/50 bg-slate-900/40 px-3 py-2.5">
              <div className="text-[11px] text-slate-400">{tr('gpuDashboardPage.realtime.gpuCount', 'Physical GPUs')}</div>
              <div className="mt-1 text-lg font-semibold text-white">{metrics.gpu_count}</div>
            </div>
          </div>

          {/* Per-GPU bars by host */}
          <div className="space-y-3">
            {[...gpusByHost.entries()].map(([hostname, gpus]) => (
              <div key={hostname} className="rounded-lg border border-slate-700/50 bg-slate-900/40 p-3">
                <div className="text-xs font-medium text-slate-300 mb-2">{hostname}</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {gpus.map((gpu) => (
                    <div key={gpu.uuid} className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-slate-400">
                          GPU {gpu.gpu} {gpu.model_name ? `(${gpu.model_name})` : ''}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-slate-500 w-8">Core</span>
                        <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${gpu.gpu_util >= 80 ? 'bg-red-500' : gpu.gpu_util >= 50 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                            style={{ width: `${Math.min(gpu.gpu_util, 100)}%` }}
                          />
                        </div>
                        <span className="text-[10px] font-mono text-slate-300 w-10 text-right">{Math.round(gpu.gpu_util)}%</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-slate-500 w-8">Mem</span>
                        <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${gpu.memory_util_percent >= 80 ? 'bg-red-500' : gpu.memory_util_percent >= 50 ? 'bg-amber-500' : 'bg-blue-500'}`}
                            style={{ width: `${Math.min(gpu.memory_util_percent, 100)}%` }}
                          />
                        </div>
                        <span className="text-[10px] font-mono text-slate-300 w-10 text-right">{Math.round(gpu.memory_util_percent)}%</span>
                      </div>
                      {gpu.memory_temp > 0 && (
                        <div className="text-[10px] text-slate-500">
                          Temp: <span className={gpu.memory_temp >= 85 ? 'text-red-400' : gpu.memory_temp >= 70 ? 'text-amber-400' : 'text-slate-400'}>{gpu.memory_temp}°C</span>
                          {gpu.exported_pod && <span className="ml-2">Pod: {gpu.exported_namespace}/{gpu.exported_pod}</span>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Node GPU Allocation + GPU Model / Pod Status */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {/* Per-Node GPU Allocation */}
        <div className="xl:col-span-2 rounded-xl border border-slate-700/50 bg-slate-800/30 p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Server className="h-4 w-4 text-slate-400" />
              <h2 className="text-sm font-semibold text-white">
                {tr('gpuDashboardPage.nodeAllocation.title', 'Node GPU Allocation')}
              </h2>
              <span className="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">
                {nodeReadyCount} {tr('gpuDashboardPage.nodeAllocation.ready', 'ready')}
                {nodeNotReadyCount > 0 && (
                  <span className="text-red-400"> / {nodeNotReadyCount} {tr('gpuDashboardPage.nodeAllocation.notReady', 'not ready')}</span>
                )}
              </span>
            </div>
            <Link
              to="/gpu/nodes"
              className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-white transition-colors"
            >
              {tr('gpuDashboardPage.viewAll', 'View all')}
              <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          {nodeAllocation.length > 0 ? (
            <div className="space-y-3">
              {nodeAllocation.map((node) => {
                const usedPct = node.gpu_allocatable > 0
                  ? Math.round((node.gpu_used / node.gpu_allocatable) * 100)
                  : 0
                return (
                  <div
                    key={node.name}
                    className="rounded-lg border border-slate-700/50 bg-slate-900/40 p-3 cursor-pointer hover:bg-slate-800/60 transition-colors"
                    onClick={() => openDetail({ kind: 'Node', name: node.name })}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-white">{node.name}</span>
                        <span className={`badge ${getStatusColor(node.status)}`}>{node.status}</span>
                      </div>
                      <span className="text-xs text-slate-400">
                        {node.gpu_model ?? 'Unknown'} {node.gpu_memory ? `• ${node.gpu_memory}` : ''}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex-1 h-2.5 bg-slate-800 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            usedPct >= 80 ? 'bg-red-500' : usedPct >= 50 ? 'bg-amber-500' : 'bg-emerald-500'
                          }`}
                          style={{ width: `${Math.min(usedPct, 100)}%` }}
                        />
                      </div>
                      <span className="text-xs font-mono text-slate-300 whitespace-nowrap">
                        {node.gpu_used}/{node.gpu_allocatable}
                        <span className="text-slate-500 ml-1">({usedPct}%)</span>
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="text-sm text-slate-400">{tr('gpuDashboardPage.nodeAllocation.empty', 'No GPU nodes available.')}</p>
          )}
        </div>

        {/* Right column: GPU Model Distribution + Pod Status Distribution */}
        <div className="flex flex-col gap-4">
          {/* GPU Model Distribution */}
          <div className="rounded-xl border border-slate-700/50 bg-slate-800/30 p-5">
            <div className="flex items-center gap-2 mb-4">
              <Monitor className="h-4 w-4 text-slate-400" />
              <h2 className="text-sm font-semibold text-white">
                {tr('gpuDashboardPage.modelDist.title', 'GPU Models')}
              </h2>
            </div>
            {modelDistribution.length > 0 ? (
              <div className="space-y-3">
                {modelDistribution.map(([model, gpuCount]) => {
                  const pct = data.total_gpu_capacity > 0
                    ? Math.round((gpuCount / data.total_gpu_capacity) * 100)
                    : 0
                  return (
                    <div key={model}>
                      <div className="flex items-center justify-between text-sm mb-1">
                        <span className="text-slate-300 truncate">{model}</span>
                        <span className="text-xs text-slate-400 ml-2 whitespace-nowrap">{gpuCount} GPU ({pct}%)</span>
                      </div>
                      <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                        <div className="h-full rounded-full bg-blue-500" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="text-sm text-slate-400">{tr('gpuDashboardPage.modelDist.empty', 'No GPU models detected.')}</p>
            )}
          </div>

          {/* Pod Status Distribution */}
          <div className="rounded-xl border border-slate-700/50 bg-slate-800/30 p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Box className="h-4 w-4 text-slate-400" />
                <h2 className="text-sm font-semibold text-white">
                  {tr('gpuDashboardPage.podStatus.title', 'Pod Status')}
                </h2>
                <span className="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">
                  {data.gpu_pods.length}
                </span>
              </div>
              <Link
                to="/gpu/pods"
                className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-white transition-colors"
              >
                {tr('gpuDashboardPage.viewAll', 'View all')}
                <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
            {podStatusDist.length > 0 ? (
              <div className="space-y-2">
                {podStatusDist.map(([status, count]) => {
                  const pct = data.gpu_pods.length > 0
                    ? Math.round((count / data.gpu_pods.length) * 100)
                    : 0
                  return (
                    <div key={status} className="flex items-center gap-3">
                      <span className={`badge ${getStatusColor(status)} w-24 justify-center`}>{status}</span>
                      <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
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
                      <span className="text-xs text-slate-400 w-16 text-right">{count} ({pct}%)</span>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="text-sm text-slate-400">{tr('gpuDashboardPage.podStatus.empty', 'No GPU pods running.')}</p>
            )}
          </div>
        </div>
      </div>

      {/* Recent GPU Pods */}
      {recentPods.length > 0 && (
        <div className="rounded-xl border border-slate-700/50 bg-slate-800/30">
          <div className="flex items-center justify-between border-b border-slate-700/50 px-5 py-3">
            <div className="flex items-center gap-2">
              <Box className="h-4 w-4 text-slate-400" />
              <h2 className="text-sm font-semibold text-white">
                {tr('gpuDashboardPage.recentPods.title', 'Recent GPU Pods')}
              </h2>
            </div>
            <Link
              to="/gpu/pods"
              className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-white transition-colors"
            >
              {tr('gpuDashboardPage.viewAll', 'View all')}
              <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700/50 text-left text-xs uppercase tracking-wider text-slate-500">
                  <th className="px-5 py-3 font-medium">{tr('gpuDashboardPage.recentPods.namespace', 'Namespace')}</th>
                  <th className="px-5 py-3 font-medium">{tr('gpuDashboardPage.recentPods.name', 'Name')}</th>
                  <th className="px-5 py-3 font-medium">{tr('gpuDashboardPage.recentPods.node', 'Node')}</th>
                  <th className="px-5 py-3 font-medium">{tr('gpuDashboardPage.recentPods.gpus', 'GPUs')}</th>
                  <th className="px-5 py-3 font-medium">{tr('gpuDashboardPage.recentPods.status', 'Status')}</th>
                  <th className="px-5 py-3 font-medium">{tr('gpuDashboardPage.recentPods.age', 'Age')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/30">
                {recentPods.map((pod: GPUPodInfo) => (
                  <tr
                    key={`${pod.namespace}/${pod.name}`}
                    className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                    onClick={() => openDetail({ kind: 'Pod', name: pod.name, namespace: pod.namespace })}
                  >
                    <td className="whitespace-nowrap px-5 py-3 text-xs font-mono">{pod.namespace}</td>
                    <td className="whitespace-nowrap px-5 py-3 font-medium text-white">{pod.name}</td>
                    <td className="whitespace-nowrap px-5 py-3 text-xs font-mono">{pod.node_name ?? '-'}</td>
                    <td className="whitespace-nowrap px-5 py-3 text-xs font-mono">{pod.gpu_requested}</td>
                    <td className="whitespace-nowrap px-5 py-3">
                      <span className={`badge ${getStatusColor(pod.status)}`}>{pod.status}</span>
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 text-xs font-mono">{formatAge(pod.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
