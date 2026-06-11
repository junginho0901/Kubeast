import { useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Server,
  RefreshCw,
  HardDrive,
  Cpu,
  Clock,
} from 'lucide-react'
import {
  api,
  disableMetrics,
  isMetricsDisabled,
  isMetricsUnavailableError,
} from '@/services/api'
import { useAIContext } from '@/hooks/useAIContext'
import { useCluster } from '@/contexts/ClusterContext'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import type { NodeMetric } from './types'

interface MonitoringNodesProps {
  metricsUnavailable: boolean
  onMetricsUnavailable: () => void
}

const parsePercent = (v?: string): number | null => {
  if (!v) return null
  const m = String(v).match(/(-?\d+(?:\.\d+)?)/)
  return m ? Number(m[1]) : null
}

const getLatestMetricTimestamp = (
  items: Array<{ timestamp?: string }> | undefined | null,
): Date | null => {
  if (!items || !Array.isArray(items) || items.length === 0) return null
  let latest: Date | null = null
  for (const item of items) {
    const ts = item?.timestamp as string | undefined
    if (!ts) continue
    const d = new Date(ts)
    if (isNaN(d.getTime())) continue
    if (!latest || d > latest) {
      latest = d
    }
  }
  return latest
}

export default function MonitoringNodes({
  metricsUnavailable,
  onMetricsUnavailable,
}: MonitoringNodesProps) {
  const { t } = useTranslation()
  const { currentCluster } = useCluster()

  const { data: nodeMetrics, isLoading, error } = useQuery<NodeMetric[], Error>({
    queryKey: ['node-metrics', currentCluster],
    queryFn: api.getNodeMetrics,
    enabled: !metricsUnavailable && !isMetricsDisabled(),
    staleTime: 5000,
    refetchInterval: () => {
      if (metricsUnavailable || isMetricsDisabled()) return false
      return 5000
    },
    retry: (failureCount, err) => {
      if (isMetricsUnavailableError(err)) return false
      return failureCount < 2
    },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 5000),
    placeholderData: (prev, prevQuery) =>
      prevQuery && prevQuery.queryKey[1] === currentCluster ? prev : undefined,
  })

  useEffect(() => {
    if (error && isMetricsUnavailableError(error)) {
      disableMetrics()
      onMetricsUnavailable()
    }
  }, [error, onMetricsUnavailable])

  // 플로팅 AI 위젯용 스냅샷 — 노드 메트릭 요약
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(nodeMetrics) || nodeMetrics.length === 0) return null
    const items = [...nodeMetrics].sort(
      (a, b) => (parsePercent(b.cpu_percent) ?? 0) - (parsePercent(a.cpu_percent) ?? 0),
    )
    const highCpu = items.filter((n) => (parsePercent(n.cpu_percent) ?? 0) > 85)
    const highMem = items.filter((n) => (parsePercent(n.memory_percent) ?? 0) > 85)
    const prefix = highCpu.length > 0 || highMem.length > 0 ? '⚠️ ' : ''
    const summary = `${prefix}노드 모니터링 — ${items.length}개 노드 실시간 사용량`
    return {
      source: 'base' as const,
      summary,
      data: {
        tab: 'nodes',
        ...summarizeList(items as unknown as Record<string, unknown>[], {
          topN: 10,
          pickFields: ['name', 'cpu', 'cpu_percent', 'memory', 'memory_percent'],
          filterProblematic: (n) => {
            const cpu = parsePercent((n as unknown as NodeMetric).cpu_percent)
            const mem = parsePercent((n as unknown as NodeMetric).memory_percent)
            return (cpu !== null && cpu > 85) || (mem !== null && mem > 85)
          },
          interpret: () => {
            const out: string[] = []
            if (highCpu.length > 0) {
              out.push(
                `⚠️ CPU 85%+ ${highCpu.length}개: ${highCpu
                  .slice(0, 5)
                  .map((n) => n.name)
                  .join(', ')}`,
              )
            }
            if (highMem.length > 0) {
              out.push(
                `⚠️ 메모리 85%+ ${highMem.length}개: ${highMem
                  .slice(0, 5)
                  .map((n) => n.name)
                  .join(', ')}`,
              )
            }
            return out
          },
          linkBuilder: (n) => {
            const node = n as unknown as NodeMetric
            return buildResourceLink('Node', undefined, node.name)
          },
        }),
      },
    }
  }, [nodeMetrics])

  useAIContext(aiSnapshot, [aiSnapshot])

  const latestNodeMetricTime = getLatestMetricTimestamp(nodeMetrics)

  return (
    <div className="card">
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-cyan-500/10">
            <Server className="w-6 h-6 text-cyan-400" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-white">{t('monitoring.nodes.title')}</h2>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 text-right">
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
            <span className="text-green-400">{t('monitoring.autoRefresh')}</span>
          </div>
          {latestNodeMetricTime && (
            <p className="text-xs text-slate-400 flex items-center gap-2">
              <Clock className="w-4 h-4" />
              <span>
                {t('monitoring.metricTimestamp', { time: latestNodeMetricTime.toLocaleTimeString() })}
              </span>
            </p>
          )}
          <p className="text-xs text-slate-500">{t('monitoring.fetchNote')}</p>
          {nodeMetrics && (
            <p className="text-xs text-slate-400">
              {t('monitoring.nodes.total', { count: nodeMetrics.length })}
            </p>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="flex flex-col items-center justify-center py-12">
          <RefreshCw className="w-8 h-8 text-primary-400 animate-spin mb-4" />
          <p className="text-slate-400">{t('monitoring.loading')}</p>
        </div>
      ) : nodeMetrics && nodeMetrics.length > 0 ? (
        <div className="space-y-6">
          {nodeMetrics.map((node) => {
            const cpuPercent = parseFloat(node.cpu_percent)
            const memoryPercent = parseFloat(node.memory_percent)

            return (
              <div key={node.name} className="p-4 bg-slate-700 rounded-lg">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-medium text-white flex items-center gap-2">
                    <Server className="w-5 h-5 text-cyan-400" />
                    {node.name}
                  </h3>
                  <div className="flex items-center gap-4 text-sm text-slate-300">
                    <div className="flex items-center gap-2">
                      <Cpu className="w-4 h-4 text-green-400" />
                      <span>{node.cpu}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <HardDrive className="w-4 h-4 text-blue-400" />
                      <span>{node.memory}</span>
                    </div>
                  </div>
                </div>

                {/* CPU 사용량 */}
                <div className="space-y-2 mb-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400 flex items-center gap-2">
                      <Cpu className="w-4 h-4" />
                      CPU
                    </span>
                    <span
                      className={`font-medium ${
                        cpuPercent >= 80
                          ? 'text-red-400'
                          : cpuPercent >= 60
                            ? 'text-yellow-400'
                            : 'text-green-400'
                      }`}
                    >
                      {node.cpu_percent}
                    </span>
                  </div>
                  <div className="w-full h-3 bg-slate-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-500 ${
                        cpuPercent >= 80
                          ? 'bg-red-500'
                          : cpuPercent >= 60
                            ? 'bg-yellow-500'
                            : 'bg-green-500'
                      }`}
                      style={{ width: `${Math.min(cpuPercent, 100)}%` }}
                    />
                  </div>
                </div>

                {/* Memory 사용량 */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400 flex items-center gap-2">
                      <HardDrive className="w-4 h-4" />
                      Memory
                    </span>
                    <span
                      className={`font-medium ${
                        memoryPercent >= 80
                          ? 'text-red-400'
                          : memoryPercent >= 60
                            ? 'text-yellow-400'
                            : 'text-blue-400'
                      }`}
                    >
                      {node.memory_percent}
                    </span>
                  </div>
                  <div className="w-full h-3 bg-slate-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-500 ${
                        memoryPercent >= 80
                          ? 'bg-red-500'
                          : memoryPercent >= 60
                            ? 'bg-yellow-500'
                            : 'bg-blue-500'
                      }`}
                      style={{ width: `${Math.min(memoryPercent, 100)}%` }}
                    />
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="text-center py-12">
          <p className="text-slate-400">{t('monitoring.nodes.unavailable')}</p>
          <p className="text-sm text-slate-500 mt-2">{t('monitoring.metricsServerHint')}</p>
        </div>
      )}
    </div>
  )
}
