import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { useAIContext } from '@/hooks/useAIContext'
import { summarizeKPI } from '@/utils/aiContext/summarizeKPI'
import { buildResourceLink } from '@/utils/resourceLink'
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
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback })
  const { open: openDetail } = useResourceDetail()

  const {
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
  } = useGPUDashboardData()

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!data) return null
    const dpStatus = data.device_plugin_status
    const dpHealthy = dpStatus ? dpStatus.ready >= dpStatus.desired : false
    const freeCount = Math.max(0, data.total_gpu_allocatable - data.total_gpu_used)
    const prefix = !dpHealthy || allocationRate >= 90 ? '⚠️ ' : ''
    const summary = `${prefix}GPU ${data.total_gpu_used}/${data.total_gpu_allocatable} 할당 (${allocationRate}%), 노드 ${data.gpu_nodes.length}개, Pod ${data.gpu_pods.length}개`

    const interpretations: string[] = []
    if (!dpHealthy && dpStatus) {
      interpretations.push(`⚠️ NVIDIA device plugin 비정상 (ready ${dpStatus.ready}/${dpStatus.desired})`)
    }
    if (allocationRate >= 90) {
      interpretations.push(`⚠️ GPU 할당률 ${allocationRate}% — 여유 ${freeCount}개`)
    }
    const hotNodes = data.gpu_nodes
      .filter((n) => n.gpu_capacity > 0 && !/ready/i.test(n.status))
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
          allocation_rate: allocationRate,
          mig_enabled: data.mig_enabled,
          time_slicing_enabled: data.time_slicing_enabled,
          device_plugin_ready: dpStatus?.ready,
          device_plugin_desired: dpStatus?.desired,
          avg_gpu_util: metrics?.avg_gpu_util,
          avg_memory_util: metrics?.avg_memory_util,
        },
        nodes: data.gpu_nodes as Array<typeof data.gpu_nodes[number] & Record<string, unknown>>,
        top_consumers: data.gpu_pods as Array<typeof data.gpu_pods[number] & Record<string, unknown>>,
      },
      {
        nodePickFields: ['name', 'gpu_model', 'gpu_capacity', 'gpu_allocatable', 'status', 'mig_strategy'],
        consumerPickFields: ['name', 'namespace', 'node_name', 'gpu_requested', 'status'],
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
  if (isError) return <GPUDashboardError tr={tr} onRefetch={() => refetch()} />
  if (!data || data.total_gpu_capacity === 0) return <GPUDashboardEmpty tr={tr} onRefetch={() => refetch()} />

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

      <SummaryCardsRow
        data={data}
        allocationRate={allocationRate}
        devicePluginHealthy={devicePluginHealthy}
        tr={tr}
      />

      <RealtimeMetricsSection
        metricsAvailable={metricsAvailable}
        metrics={metrics}
        gpusByHost={gpusByHost}
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
