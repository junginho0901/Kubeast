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

  const allocationRate = useMemo(() => {
    if (!data || data.total_gpu_allocatable === 0) return 0
    return Math.round((data.total_gpu_used / data.total_gpu_allocatable) * 100)
  }, [data])

  const devicePluginHealthy = useMemo(() => {
    if (!data?.device_plugin_status) return false
    return data.device_plugin_status.ready >= data.device_plugin_status.desired
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
        <SkeletonTable cols={7} />
        <SkeletonTable cols={6} />
      </div>
    )
  }

  // Error state — show retry button instead of misleading "no GPU" message
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

      {/* GPU Nodes Table */}
      <div className="overflow-hidden rounded-xl border border-slate-700/50 bg-slate-800/30">
        <div className="flex items-center gap-2 border-b border-slate-700/50 px-5 py-3">
          <Server className="h-4 w-4 text-slate-400" />
          <h2 className="text-sm font-semibold text-white">
            {tr('gpuDashboardPage.nodes.title', 'GPU Nodes')}
          </h2>
          <span className="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">
            {data.gpu_nodes.length}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700/50 text-left text-xs uppercase tracking-wider text-slate-500">
                <th className="px-5 py-3 font-medium">{tr('gpuDashboardPage.nodes.name', 'Name')}</th>
                <th className="px-5 py-3 font-medium">{tr('gpuDashboardPage.nodes.gpuModel', 'GPU Model')}</th>
                <th className="px-5 py-3 font-medium">{tr('gpuDashboardPage.nodes.gpuMemory', 'GPU Memory')}</th>
                <th className="px-5 py-3 font-medium">{tr('gpuDashboardPage.nodes.capacity', 'Capacity')}</th>
                <th className="px-5 py-3 font-medium">{tr('gpuDashboardPage.nodes.allocatable', 'Allocatable')}</th>
                <th className="px-5 py-3 font-medium">{tr('gpuDashboardPage.nodes.status', 'Status')}</th>
                <th className="px-5 py-3 font-medium">{tr('gpuDashboardPage.nodes.migStrategy', 'MIG Strategy')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/30">
              {data.gpu_nodes.map((node: GPUNodeInfo) => (
                <tr
                  key={node.name}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({ kind: 'Node', name: node.name })}
                >
                  <td className="whitespace-nowrap px-5 py-3 font-medium text-white">{node.name}</td>
                  <td className="whitespace-nowrap px-5 py-3">{node.gpu_model ?? '-'}</td>
                  <td className="whitespace-nowrap px-5 py-3">{node.gpu_memory ?? '-'}</td>
                  <td className="whitespace-nowrap px-5 py-3">{node.gpu_capacity}</td>
                  <td className="whitespace-nowrap px-5 py-3">{node.gpu_allocatable}</td>
                  <td className="whitespace-nowrap px-5 py-3">
                    <NodeStatusBadge status={node.status} />
                  </td>
                  <td className="whitespace-nowrap px-5 py-3">{node.mig_strategy ?? '-'}</td>
                </tr>
              ))}
              {data.gpu_nodes.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-8 text-center text-slate-500">
                    {tr('gpuDashboardPage.nodes.empty', 'No GPU nodes found.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* GPU Pods Table */}
      <div className="overflow-hidden rounded-xl border border-slate-700/50 bg-slate-800/30">
        <div className="flex items-center gap-2 border-b border-slate-700/50 px-5 py-3">
          <Box className="h-4 w-4 text-slate-400" />
          <h2 className="text-sm font-semibold text-white">
            {tr('gpuDashboardPage.pods.title', 'GPU Pods')}
          </h2>
          <span className="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">
            {data.gpu_pods.length}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700/50 text-left text-xs uppercase tracking-wider text-slate-500">
                <th className="px-5 py-3 font-medium">{tr('gpuDashboardPage.pods.namespace', 'Namespace')}</th>
                <th className="px-5 py-3 font-medium">{tr('gpuDashboardPage.pods.name', 'Name')}</th>
                <th className="px-5 py-3 font-medium">{tr('gpuDashboardPage.pods.node', 'Node')}</th>
                <th className="px-5 py-3 font-medium">{tr('gpuDashboardPage.pods.gpus', 'GPUs')}</th>
                <th className="px-5 py-3 font-medium">{tr('gpuDashboardPage.pods.status', 'Status')}</th>
                <th className="px-5 py-3 font-medium">{tr('gpuDashboardPage.pods.age', 'Age')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/30">
              {data.gpu_pods.map((pod: GPUPodInfo) => (
                <tr
                  key={`${pod.namespace}/${pod.name}`}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({ kind: 'Pod', name: pod.name, namespace: pod.namespace })}
                >
                  <td className="whitespace-nowrap px-5 py-3">{pod.namespace}</td>
                  <td className="whitespace-nowrap px-5 py-3 font-medium text-white">{pod.name}</td>
                  <td className="whitespace-nowrap px-5 py-3">{pod.node_name ?? '-'}</td>
                  <td className="whitespace-nowrap px-5 py-3">{pod.gpu_requested}</td>
                  <td className="whitespace-nowrap px-5 py-3">
                    <PodStatusBadge status={pod.status} />
                  </td>
                  <td className="whitespace-nowrap px-5 py-3">{formatAge(pod.created_at)}</td>
                </tr>
              ))}
              {data.gpu_pods.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-8 text-center text-slate-500">
                    {tr('gpuDashboardPage.pods.empty', 'No GPU pods found.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
