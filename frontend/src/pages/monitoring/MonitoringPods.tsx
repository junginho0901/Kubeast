import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Box,
  RefreshCw,
  Activity,
  HardDrive,
  Cpu,
  Clock,
} from 'lucide-react'
import {
  api,
  disableMetrics,
  isMetricsDisabled,
  isMetricsUnavailableError,
  type PodInfo,
} from '@/services/api'
import { useAIContext } from '@/hooks/useAIContext'
import { useCluster } from '@/contexts/ClusterContext'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import { NamespaceFilter } from './MonitoringFilters'
import type { PodMetric } from './types'

interface MonitoringPodsProps {
  metricsUnavailable: boolean
  onMetricsUnavailable: () => void
  namespaces: { name: string }[] | undefined
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

export default function MonitoringPods({
  metricsUnavailable,
  onMetricsUnavailable,
  namespaces,
}: MonitoringPodsProps) {
  const { t } = useTranslation()
  const [selectedNamespace, setSelectedNamespace] = useState<string>('')
  const { currentCluster } = useCluster()

  // Pod 리소스 사용량 (네임스페이스 선택 시에만 활성화, 5초마다 자동 갱신)
  const { data: podMetrics, isLoading, error } = useQuery<PodMetric[], Error>({
    queryKey: ['pod-metrics', currentCluster, selectedNamespace],
    queryFn: () => api.getPodMetrics(selectedNamespace === 'all' ? undefined : selectedNamespace),
    staleTime: 5000,
    refetchInterval: () => {
      if (metricsUnavailable || isMetricsDisabled()) return false
      return 5000
    },
    enabled: !!selectedNamespace && !metricsUnavailable && !isMetricsDisabled(),
    retry: (failureCount, err) => {
      if (isMetricsUnavailableError(err)) return false
      return failureCount < 2
    },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 5000),
    placeholderData: (prev, prevQuery) =>
      prevQuery && prevQuery.queryKey[1] === currentCluster ? prev : undefined,
  })

  // Pod 상세 정보 (Limit/Request 포함) — 네임스페이스 선택 시에만 활성화
  const { data: allPods } = useQuery<PodInfo[], Error>({
    queryKey: ['all-pods-detail', currentCluster],
    queryFn: () => api.getAllPods(false),
    staleTime: 10000,
    refetchInterval: 10000,
    enabled: !!selectedNamespace,
  })

  useEffect(() => {
    if (error && isMetricsUnavailableError(error)) {
      disableMetrics()
      onMetricsUnavailable()
    }
  }, [error, onMetricsUnavailable])

  // 플로팅 AI 위젯용 스냅샷 — Pod 메트릭 요약
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(podMetrics) || podMetrics.length === 0) return null
    const items = [...podMetrics].sort((a, b) => {
      const aCpu = Number(String(a.cpu).replace(/[^0-9.]/g, '')) || 0
      const bCpu = Number(String(b.cpu).replace(/[^0-9.]/g, '')) || 0
      return bCpu - aCpu
    })
    const nsLabel = selectedNamespace === 'all' ? '전체' : selectedNamespace
    return {
      source: 'base' as const,
      summary: `Pod 모니터링 — ${nsLabel} ${items.length}개 Pod 실시간 사용량`,
      data: {
        tab: 'pods',
        filters: { namespace: selectedNamespace },
        ...summarizeList(items as unknown as Record<string, unknown>[], {
          topN: 15,
          pickFields: ['name', 'namespace', 'cpu', 'memory'],
          linkBuilder: (p) => {
            const pod = p as unknown as PodMetric
            return buildResourceLink('Pod', pod.namespace, pod.name)
          },
        }),
      },
    }
  }, [podMetrics, selectedNamespace])

  useAIContext(aiSnapshot, [aiSnapshot])

  const podStats = podMetrics
    ? {
        totalPods: podMetrics.length,
        totalCpu: podMetrics.reduce((acc, pod) => {
          const cpu = parseInt(pod.cpu.replace('m', ''))
          return acc + (isNaN(cpu) ? 0 : cpu)
        }, 0),
        totalMemory: podMetrics.reduce((acc, pod) => {
          const memory = parseInt(pod.memory.replace('Mi', ''))
          return acc + (isNaN(memory) ? 0 : memory)
        }, 0),
      }
    : null

  const latestPodMetricTime = getLatestMetricTimestamp(podMetrics)

  return (
    <div className="card overflow-visible">
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-green-500/10">
            <Box className="w-6 h-6 text-green-400" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-white">{t('monitoring.pods.title')}</h2>
            <p className="text-sm text-slate-400">{t('monitoring.pods.subtitle')}</p>
          </div>
        </div>
        {selectedNamespace && (
          <div className="flex flex-col items-end gap-1 text-right">
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
              <span className="text-green-400">{t('monitoring.autoRefresh')}</span>
            </div>
            {latestPodMetricTime && (
              <p className="text-xs text-slate-400 flex items-center gap-2">
                <Clock className="w-4 h-4" />
                <span>
                  {t('monitoring.metricTimestamp', { time: latestPodMetricTime.toLocaleTimeString() })}
                </span>
              </p>
            )}
            <p className="text-xs text-slate-500">{t('monitoring.fetchNote')}</p>
          </div>
        )}
      </div>

      <NamespaceFilter
        namespaces={namespaces}
        value={selectedNamespace}
        onChange={setSelectedNamespace}
      />

      {/* 네임스페이스 미선택 시 안내 메시지 */}
      {!selectedNamespace && (
        <div className="text-center py-12 bg-slate-700/50 rounded-lg border-2 border-dashed border-slate-600">
          <Box className="w-12 h-12 text-slate-500 mx-auto mb-4" />
          <p className="text-slate-400 text-lg font-medium">
            {t('monitoring.namespace.promptTitle')}
          </p>
          <p className="text-sm text-slate-500 mt-2">
            {t('monitoring.namespace.promptSubtitle')}
          </p>
        </div>
      )}

      {/* Pod 통계 카드 */}
      {selectedNamespace && podStats && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="p-4 bg-slate-700 rounded-lg">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-400">{t('monitoring.pods.totalPods')}</p>
                <p className="text-2xl font-bold text-white mt-1">{podStats.totalPods}</p>
              </div>
              <Box className="w-8 h-8 text-green-400" />
            </div>
          </div>
          <div className="p-4 bg-slate-700 rounded-lg">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-400">{t('monitoring.pods.totalCpu')}</p>
                <p className="text-2xl font-bold text-white mt-1">{podStats.totalCpu}m</p>
              </div>
              <Cpu className="w-8 h-8 text-green-400" />
            </div>
          </div>
          <div className="p-4 bg-slate-700 rounded-lg">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-400">{t('monitoring.pods.totalMemory')}</p>
                <p className="text-2xl font-bold text-white mt-1">{podStats.totalMemory}Mi</p>
              </div>
              <HardDrive className="w-8 h-8 text-blue-400" />
            </div>
          </div>
        </div>
      )}

      {selectedNamespace && isLoading ? (
        <div className="flex flex-col items-center justify-center py-12">
          <RefreshCw className="w-8 h-8 text-primary-400 animate-spin mb-4" />
          <p className="text-slate-400">{t('monitoring.loading')}</p>
        </div>
      ) : selectedNamespace && podMetrics && podMetrics.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-700">
                <th className="text-left py-3 px-4 text-slate-400 font-medium">
                  {t('monitoring.table.pod')}
                </th>
                <th className="text-left py-3 px-4 text-slate-400 font-medium">
                  {t('monitoring.table.namespace')}
                </th>
                <th className="text-left py-3 px-4 text-slate-400 font-medium">
                  <div className="flex items-center gap-2">
                    <Cpu className="w-4 h-4" />
                    {t('monitoring.table.cpuUsage')}
                  </div>
                </th>
                <th className="text-left py-3 px-4 text-slate-400 font-medium">
                  <div className="flex items-center gap-2">
                    <Cpu className="w-4 h-4" />
                    {t('monitoring.table.cpuLimit')}
                  </div>
                </th>
                <th className="text-left py-3 px-4 text-slate-400 font-medium">
                  <div className="flex items-center gap-2">
                    <HardDrive className="w-4 h-4" />
                    {t('monitoring.table.memoryUsage')}
                  </div>
                </th>
                <th className="text-left py-3 px-4 text-slate-400 font-medium">
                  <div className="flex items-center gap-2">
                    <HardDrive className="w-4 h-4" />
                    {t('monitoring.table.memoryLimit')}
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              {podMetrics.map((podMetric) => {
                const cpu = parseInt(podMetric.cpu.replace('m', ''))
                const memory = parseInt(podMetric.memory.replace('Mi', ''))

                // Pod 상세 정보에서 Limit/Request 찾기
                const podDetail = allPods?.find(
                  (p) => p.name === podMetric.name && p.namespace === podMetric.namespace,
                )

                // 모든 컨테이너의 Limit 합산
                let cpuLimit = 'None'
                let memoryLimit = 'None'

                if (podDetail?.containers) {
                  let totalCpuLimit = 0
                  let totalMemoryLimit = 0
                  let hasCpuLimit = false
                  let hasMemoryLimit = false

                  podDetail.containers.forEach((container: any) => {
                    if (container.limits?.cpu) {
                      hasCpuLimit = true
                      const cpuStr = container.limits.cpu
                      if (cpuStr.endsWith('m')) {
                        totalCpuLimit += parseInt(cpuStr.replace('m', ''))
                      } else {
                        totalCpuLimit += parseInt(cpuStr) * 1000
                      }
                    }

                    if (container.limits?.memory) {
                      hasMemoryLimit = true
                      const memStr = container.limits.memory
                      if (memStr.endsWith('Mi')) {
                        totalMemoryLimit += parseInt(memStr.replace('Mi', ''))
                      } else if (memStr.endsWith('Gi')) {
                        totalMemoryLimit += parseInt(memStr.replace('Gi', '')) * 1024
                      } else if (memStr.endsWith('Ki')) {
                        totalMemoryLimit += parseInt(memStr.replace('Ki', '')) / 1024
                      }
                    }
                  })

                  if (hasCpuLimit) cpuLimit = `${totalCpuLimit}m`
                  if (hasMemoryLimit) memoryLimit = `${Math.round(totalMemoryLimit)}Mi`
                }

                return (
                  <tr
                    key={`${podMetric.namespace}-${podMetric.name}`}
                    className="border-b border-slate-700/50 hover:bg-slate-700/30"
                  >
                    <td className="py-3 px-4 text-white font-mono text-sm">{podMetric.name}</td>
                    <td className="py-3 px-4">
                      <span className="badge badge-info text-xs">{podMetric.namespace}</span>
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <Activity
                          className={`w-4 h-4 ${
                            cpu >= 1000
                              ? 'text-red-400'
                              : cpu >= 500
                                ? 'text-yellow-400'
                                : 'text-green-400'
                          }`}
                        />
                        <span className="text-white font-mono">{podMetric.cpu}</span>
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`font-mono text-sm ${
                          cpuLimit === 'None' ? 'text-slate-500' : 'text-slate-300'
                        }`}
                      >
                        {cpuLimit}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <Activity
                          className={`w-4 h-4 ${
                            memory >= 1024
                              ? 'text-red-400'
                              : memory >= 512
                                ? 'text-yellow-400'
                                : 'text-blue-400'
                          }`}
                        />
                        <span className="text-white font-mono">{podMetric.memory}</span>
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`font-mono text-sm ${
                          memoryLimit === 'None' ? 'text-slate-500' : 'text-slate-300'
                        }`}
                      >
                        {memoryLimit}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : selectedNamespace && error ? (
        <div className="text-center py-12">
          <div className="flex flex-col items-center gap-4">
            <Activity className="w-12 h-12 text-red-400 animate-pulse" />
            <div>
              <p className="text-red-400 font-medium">{t('monitoring.pods.errorTitle')}</p>
              <p className="text-sm text-slate-500 mt-2">{t('monitoring.pods.retrying')}</p>
            </div>
          </div>
        </div>
      ) : selectedNamespace ? (
        <div className="text-center py-12">
          <p className="text-slate-400">
            {selectedNamespace === 'all'
              ? t('monitoring.pods.unavailableAll')
              : t('monitoring.pods.noPodsInNamespace', { namespace: selectedNamespace })}
          </p>
          {selectedNamespace === 'all' && (
            <p className="text-sm text-slate-500 mt-2">{t('monitoring.metricsServerHint')}</p>
          )}
        </div>
      ) : null}
    </div>
  )
}
