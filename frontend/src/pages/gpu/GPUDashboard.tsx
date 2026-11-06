import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { useAIContext } from '@/hooks/useAIContext'
import { summarizeKPI } from '@/utils/aiContext/summarizeKPI'
import { buildResourceLink } from '@/utils/resourceLink'
import { forbiddenResourceFromUrl } from '@/utils/forbiddenResource'
import { isForbiddenError } from '@/services/api'
import { nodeReadiness } from '@/utils/nodeStatus'
import { devicePluginState, gpuHolderPods, gpuNodeCounts, gpuRealtimeAverages } from './gpuNumbers'
import type { GPUDevicePlugin } from '@/services/api'
import { RefreshCw } from 'lucide-react'

import { useGPUDashboardData } from './gpu-dashboard/useGPUDashboardData'
import { GPUDashboardLoading, GPUDashboardError, GPUDashboardEmpty } from './gpu-dashboard/GPUDashboardStates'
import { SummaryCardsRow } from './gpu-dashboard/SummaryCardsRow'
import { RealtimeMetricsSection } from './gpu-dashboard/RealtimeMetricsSection'
import { NodeAllocationSection } from './gpu-dashboard/NodeAllocationSection'
import { DistributionsSection } from './gpu-dashboard/DistributionsSection'
import { RecentPodsSection } from './gpu-dashboard/RecentPodsSection'

export default function GPUDashboard() {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, unknown>) => t(key, { defaultValue: fallback, ...options })
  const { open: openDetail } = useResourceDetail()

  const {
    data,
    metrics,
    metricsAvailable,
    gpusByHost,
    allocationRate,
    devicePlugins,
    nodeAllocation,
    modelDistribution,
    podStatusDist,
    recentPods,
    isLoading,
    isError,
    error,
    refetch,
  } = useGPUDashboardData()

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!data) return null
    const plugins: GPUDevicePlugin[] = data.device_plugins ?? []
    const averages = metrics ? gpuRealtimeAverages(metrics) : undefined
    // a plugin not found is not an unhealthy one
    const unhealthy = plugins.filter((p) => devicePluginState(p) === 'unhealthy')
    const freeCount = Math.max(0, data.total_gpu_allocatable - data.total_gpu_used)
    const prefix = unhealthy.length > 0 || allocationRate >= 90 ? '⚠️ ' : ''
    const summary = `${prefix}GPU ${data.total_gpu_used}/${data.total_gpu_allocatable} 할당 (${allocationRate}%), 노드 ${data.gpu_nodes.length}개, Pod ${data.gpu_pods.length}개`

    const interpretations: string[] = []
    for (const p of unhealthy) {
      interpretations.push(`⚠️ ${p.vendor} device plugin 비정상 (ready ${p.ready}/${p.desired})`)
    }
    if (allocationRate >= 90) {
      interpretations.push(`⚠️ GPU 할당률 ${allocationRate}% — 여유 ${freeCount}개`)
    }
    if (data.total_gpu_waiting > 0) {
      interpretations.push(`노드 배정을 기다리는 Pod의 GPU 요청 ${data.total_gpu_waiting}개 (할당에 미포함)`)
    }
    const hotNodes = data.gpu_nodes
      .filter((n) => n.gpu_capacity > 0 && nodeReadiness(n.status) !== 'Ready')
      .map((n) => n.name)
    if (hotNodes.length > 0) {
      interpretations.push(`⚠️ NotReady GPU 노드 ${hotNodes.length}개: ${hotNodes.slice(0, 5).join(', ')}`)
    }

    const kpi = summarizeKPI<
      { name: string; gpu_model?: string | null; gpu_capacity: number; gpu_allocatable: number; status: string } & Record<string, unknown>,
      { name: string; namespace: string; node_name?: string | null; gpu_requested: number; status: string } & Record<string, unknown>
    >(
      {
        cluster_gpu: {
          total_capacity: data.total_gpu_capacity,
          total_allocatable: data.total_gpu_allocatable,
          total_used: data.total_gpu_used,
          total_waiting: data.total_gpu_waiting,
          allocation_rate: allocationRate,
          ready_nodes: gpuNodeCounts(data.gpu_nodes).ready,
          // each company's GPUs: capacity, allocatable, in use and waiting
          vendors: data.vendors ?? [],
          mig_enabled: data.mig_enabled,
          time_slicing_enabled: data.time_slicing_enabled,
          device_plugins: plugins.map((p) => ({
            vendor: p.vendor, state: devicePluginState(p), ready: p.ready, desired: p.desired,
            ...(devicePluginState(p) === 'missing' ? { note: 'not under the names Kubeast looks for; it may run under another name' } : {}),
          })),
          avg_gpu_util: averages?.util,
          avg_memory_util: averages?.memory,
        },
        nodes: data.gpu_nodes as Array<typeof data.gpu_nodes[number] & Record<string, unknown>>,
        // the pods asking for the most GPUs first
        top_consumers: [...data.gpu_pods].sort((a, b) => b.gpu_requested - a.gpu_requested) as Array<typeof data.gpu_pods[number] & Record<string, unknown>>,
      },
      {
        nodePickFields: ['name', 'gpu_vendors', 'gpu_model', 'gpu_capacity', 'gpu_allocatable', 'gpu_used', 'status', 'mig_strategy'],
        consumerPickFields: ['name', 'namespace', 'node_name', 'gpu_requested', 'gpu_vendors', 'status'],
        topN: { nodes: 10, consumers: 10 },
      },
    )

    // 각 consumer 에 kubest:// 링크 부착
    const consumers_with_link = kpi.top_consumers.map((c) => {
      const namespace = c.namespace as string | undefined
      const name = c.name as string | undefined
      const link = name ? buildResourceLink('Pod', namespace, name) : null
      return link ? { ...c, _link: link } : c
    })

    return {
      source: 'base' as const,
      summary,
      data: {
        ...kpi,
        top_consumers: consumers_with_link,
        ...(interpretations.length > 0 ? { interpretations } : {}),
      },
    }
  }, [data, metrics, allocationRate])

  useAIContext(aiSnapshot, [aiSnapshot])

  if (isLoading) return <GPUDashboardLoading />
  if (isError) {
    const forbidden = isForbiddenError(error)
      ? t('common.forbiddenEmpty', { resource: forbiddenResourceFromUrl('/cluster/gpu/dashboard'), defaultValue: 'You do not have permission to view {{resource}} in this cluster.' })
      : undefined
    return <GPUDashboardError tr={tr} onRefetch={() => refetch()} forbidden={forbidden} />
  }
  // empty only without GPUs and without pods asking for one (pods can wait for GPU nodes that are not there yet)
  if (!data || (data.total_gpu_capacity === 0 && data.gpu_pods.length === 0)) return <GPUDashboardEmpty tr={tr} onRefetch={() => refetch()} />

  const { ready: nodeReadyCount, notReady: nodeNotReadyCount } = gpuNodeCounts(data.gpu_nodes)
  const gpuPodKeys = gpuHolderPods(data)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="page-head items-center">
        <div>
          <h1 className="text-3xl font-semibold text-ink">
            {tr('gpuDashboardPage.title', 'GPU Dashboard')}
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {tr('gpuDashboardPage.subtitle', 'GPU resource overview across the cluster')}
          </p>
        </div>
        <button
          onClick={() => refetch()}
          className="btn btn-primary flex items-center gap-2"
        >
          <RefreshCw className="h-4 w-4" />
          {tr('common.refresh', 'Refresh')}
        </button>
      </div>

      <SummaryCardsRow
        data={data}
        allocationRate={allocationRate}
        devicePlugins={devicePlugins}
        tr={tr}
      />

      <RealtimeMetricsSection
        metricsAvailable={metricsAvailable}
        metrics={metrics}
        gpusByHost={gpusByHost}
        gpuPodKeys={gpuPodKeys}
        tr={tr}
      />

      {/* Node GPU Allocation + GPU Model / Pod Status */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <NodeAllocationSection
          nodeAllocation={nodeAllocation}
          nodeReadyCount={nodeReadyCount}
          nodeNotReadyCount={nodeNotReadyCount}
          openDetail={openDetail}
          tr={tr}
        />
        <DistributionsSection
          data={data}
          modelDistribution={modelDistribution}
          podStatusDist={podStatusDist}
          tr={tr}
        />
      </div>

      <RecentPodsSection recentPods={recentPods} openDetail={openDetail} tr={tr} />
    </div>
  )
}
