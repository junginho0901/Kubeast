import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { formatTime } from '@/utils/time'
import {
  Box,
  RefreshCw,
  Activity,
  HardDrive,
  Cpu,
  Clock,
} from 'lucide-react'
import { ListPager } from '@/components/ListPager'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { usePagedItems } from '@/hooks/usePagedItems'
import { cpuToMillis, memoryToBytes } from '@/utils/resourceQuantity'
import { usageTone } from './podUsage'
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
import { MonitoringSearch, NamespaceFilter } from './MonitoringFilters'
import { MetricsRefreshFailed } from './MetricsRefreshFailed'
import { metricsRefreshFailure, refreshFailureForChat } from './metricsRefresh'
import type { PodMetric } from './types'

interface MonitoringPodsProps {
  metricsUnavailable: boolean
  onMetricsUnavailable: () => void
  namespaces: { name: string }[] | undefined
}

const MIB = 1024 ** 2
const COLUMNS = 6

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
  const [search, setSearch] = useState('')
  const { currentCluster } = useCluster()
  const { open: openDetail } = useResourceDetail()

  // Pod 리소스 사용량 (네임스페이스 선택 시에만 활성화, 5초마다 자동 갱신)
  const { data: podMetrics, isLoading, error, dataUpdatedAt } = useQuery<PodMetric[], Error>({
    queryKey: ['pod-metrics', currentCluster, selectedNamespace],
    // with each pod's limits from k8s-service's pod rows, so the page takes no pod list
    queryFn: () => api.getPodMetrics(selectedNamespace === 'all' ? undefined : selectedNamespace, true),
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
  })

  useEffect(() => {
    if (error && isMetricsUnavailableError(error)) {
      disableMetrics()
      onMetricsUnavailable()
    }
  }, [error, onMetricsUnavailable])

  const refreshFailure = useMemo(() => metricsRefreshFailure(error, podMetrics, dataUpdatedAt), [error, podMetrics, dataUpdatedAt])

  // 플로팅 AI 위젯용 스냅샷 — Pod 메트릭 요약
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(podMetrics)) return null
    const items = [...podMetrics].sort((a, b) => {
      const aCpu = Number(String(a.cpu).replace(/[^0-9.]/g, '')) || 0
      const bCpu = Number(String(b.cpu).replace(/[^0-9.]/g, '')) || 0
      return bCpu - aCpu
    })
    const nsLabel = selectedNamespace === 'all' ? '전체' : selectedNamespace
    return {
      source: 'base' as const,
      summary: `Pod 모니터링 — ${nsLabel} ${items.length}개 Pod ${refreshFailure ? '사용량, 새로고침 실패로 옛 값' : '실시간 사용량'}`,
      data: {
        tab: 'pods',
        ...(refreshFailure ? { refresh_failed: refreshFailureForChat(refreshFailure) } : {}),
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
  }, [podMetrics, selectedNamespace, refreshFailure])

  useAIContext(aiSnapshot, [aiSnapshot])

  const rows = useMemo(() => {
    if (!Array.isArray(podMetrics)) return []
    return podMetrics.map((m) => {
      const cpu = cpuToMillis(m.cpu)
      const memory = memoryToBytes(m.memory)
      // the pod's limits as the kubelet sizes its cgroup, null when it sets none (k8s-service podLimits)
      const cpuLimit = m.cpu_limit_millicores ?? null
      const memoryLimit = m.memory_limit_bytes ?? null
      return {
        metric: m,
        cpu,
        memory,
        cpuLimit,
        memoryLimit,
        cpuPct: cpu !== null && cpuLimit ? (cpu / cpuLimit) * 100 : null,
        memoryPct: memory !== null && memoryLimit ? (memory / memoryLimit) * 100 : null,
      }
    })
  }, [podMetrics])

  const podStats = podMetrics
    ? {
        totalPods: podMetrics.length,
        totalCpu: rows.reduce((acc, r) => acc + (r.cpu ?? 0), 0),
        totalMemory: Math.round(rows.reduce((acc, r) => acc + (r.memory ?? 0), 0) / MIB),
      }
    : null

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? rows.filter((r) => r.metric.name.toLowerCase().includes(q)) : rows
  }, [rows, search])
  // a page at a time in a box sized to the screen, as the list pages; a new search, namespace or cluster starts at the
  // first page
  const { containerRef, bodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({ recalculationKey: filteredRows.length })
  const { items: pagedRows, page, totalPages, total, setPage } = usePagedItems(filteredRows, rowsPerPage, `${search}|${selectedNamespace}|${currentCluster}`)

  const latestPodMetricTime = getLatestMetricTimestamp(podMetrics)

  return (
    <div className="card overflow-visible flex-1 min-h-0 flex flex-col">
      <div className="flex items-start justify-between mb-6 shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-slate-700/60">
            <Box className="w-6 h-6 text-slate-300" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-ink">{t('monitoring.pods.title')}</h2>
            <p className="text-sm text-slate-400">{t('monitoring.pods.subtitle')}</p>
          </div>
        </div>
        {selectedNamespace && (
          <div className="flex flex-col items-end gap-1 text-right">
            {latestPodMetricTime && (
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <div className={`w-2 h-2 rounded-full ${refreshFailure ? 'bg-amber-500' : 'bg-green-500'}`}></div>
                <span className="text-slate-400">{t('monitoring.autoRefresh')}</span>
              </div>
            )}
            {latestPodMetricTime && (
              <p className="text-xs text-slate-400 flex items-center gap-2">
                <Clock className="w-4 h-4" />
                <span>
                  {t('monitoring.metricTimestamp', { time: formatTime(latestPodMetricTime) })}
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

      {selectedNamespace && podMetrics && podMetrics.length > 0 && (
        <MonitoringSearch value={search} onChange={setSearch} placeholder={t('monitoring.pods.searchPlaceholder', 'Search pods by name...')} testId="monitoring-pod-search" />
      )}

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

      {selectedNamespace && refreshFailure && <MetricsRefreshFailed failure={refreshFailure} retrying={!metricsUnavailable} testId="pod-metrics-refresh-failed" />}

      {/* The cards keep their place with "-" while a read is under way, so the table below does not jump */}
      {selectedNamespace && (podStats || isLoading) && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="p-4 bg-slate-700 rounded-lg">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-400">{t('monitoring.pods.totalPods')}</p>
                <p className="text-2xl font-bold text-ink mt-1">{podStats ? podStats.totalPods : '-'}</p>
              </div>
              <Box className="w-8 h-8 text-slate-500" />
            </div>
          </div>
          <div className="p-4 bg-slate-700 rounded-lg">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-400">{t('monitoring.pods.totalCpu')}</p>
                <p className="text-2xl font-bold text-ink mt-1">{podStats ? `${podStats.totalCpu}m` : '-'}</p>
              </div>
              <Cpu className="w-8 h-8 text-slate-500" />
            </div>
          </div>
          <div className="p-4 bg-slate-700 rounded-lg">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-400">{t('monitoring.pods.totalMemory')}</p>
                <p className="text-2xl font-bold text-ink mt-1">{podStats ? `${podStats.totalMemory}Mi` : '-'}</p>
              </div>
              <HardDrive className="w-8 h-8 text-slate-500" />
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
        <div ref={containerRef} className="flex-1 min-h-0 flex flex-col">
          <div ref={bodyRef} className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full">
            <thead ref={theadRef}>
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
              {pagedRows.map(({ metric: podMetric, cpuLimit, memoryLimit, cpuPct, memoryPct }, idx) => (
                <tr
                  key={`${podMetric.namespace}-${podMetric.name}`}
                  ref={idx === 0 ? firstRowRef : undefined}
                  onClick={() => openDetail({ kind: 'Pod', name: podMetric.name, namespace: podMetric.namespace })}
                  data-testid="monitoring-pod-row"
                  className="border-b border-slate-700/50 hover:bg-slate-700/30 cursor-pointer"
                >
                  <td className="py-3 px-4 text-ink font-mono text-sm">{podMetric.name}</td>
                  <td className="py-3 px-4 font-mono text-xs text-slate-300">{podMetric.namespace}</td>
                  <td className="py-3 px-4">
                    <span className={`font-mono ${usageTone(cpuPct)}`} data-testid="monitoring-pod-cpu">{podMetric.cpu}</span>
                  </td>
                  <td className="py-3 px-4 font-mono text-sm">
                    {cpuLimit === null ? (
                      <span className="text-slate-500">-</span>
                    ) : (
                      <span className="text-slate-300">
                        {cpuLimit}m <span className="text-slate-400" data-testid="monitoring-pod-cpu-pct">({Math.round(cpuPct ?? 0)}%)</span>
                      </span>
                    )}
                  </td>
                  <td className="py-3 px-4">
                    <span className={`font-mono ${usageTone(memoryPct)}`}>{podMetric.memory}</span>
                  </td>
                  <td className="py-3 px-4 font-mono text-sm">
                    {memoryLimit === null ? (
                      <span className="text-slate-500">-</span>
                    ) : (
                      <span className="text-slate-300">
                        {Math.round(memoryLimit / MIB)}Mi <span className="text-slate-400">({Math.round(memoryPct ?? 0)}%)</span>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {filteredRows.length === 0 && (
                <tr>
                  <td colSpan={COLUMNS} className="py-10 px-4 text-center text-slate-400" data-testid="monitoring-pod-empty">
                    {t('common.noSearchResults', 'No results found.')}
                  </td>
                </tr>
              )}
            </tbody>
            <AdaptiveTableFillerRows count={rowsPerPage - pagedRows.length - (filteredRows.length === 0 ? 1 : 0)} columnCount={COLUMNS} />
          </table>
          </div>
          <ListPager currentPage={page} totalPages={totalPages} total={total} rowsPerPage={rowsPerPage} onPageChange={setPage} testId="monitoring-pod-pager" />
        </div>
      ) : selectedNamespace && error && !isMetricsUnavailableError(error) ? (
        <div className="text-center py-12">
          <div className="flex flex-col items-center gap-4">
            <Activity className="w-12 h-12 text-red-400 animate-pulse" />
            <div>
              <p className="text-red-400 font-medium" data-testid="pod-metrics-error">{t('monitoring.pods.errorTitle')}</p>
              {(error as any).response?.data?.detail && <p className="text-sm text-slate-400 mt-2">{(error as any).response.data.detail}</p>}
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
