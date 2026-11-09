import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { formatTime } from '@/utils/time'
import {
  Activity,
  Server,
  RefreshCw,
  Clock,
} from 'lucide-react'
import {
  api,
  disableMetrics,
  isForbiddenError,
  isMetricsDisabled,
  isMetricsUnavailableError,
} from '@/services/api'
import { forbiddenResourceFromUrl } from '@/utils/forbiddenResource'
import { useAIContext } from '@/hooks/useAIContext'
import { useCluster } from '@/contexts/ClusterContext'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import { ListPager } from '@/components/ListPager'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { usePagedItems } from '@/hooks/usePagedItems'
import { MonitoringSearch } from './MonitoringFilters'
import { MetricsRefreshFailed } from './MetricsRefreshFailed'
import { metricsRefreshFailure, refreshFailureForChat } from './metricsRefresh'
import type { NodeMetric } from './types'

const COLUMNS = 5

// A node's share of its allocatable as kubectl top prints it, with a bar: the accent, yellow from 60 %, red from 80 %.
function UsageCell({ text, testId }: { text: string; testId: string }) {
  // a node without a sample ('-') draws an empty bar
  const percent = parseFloat(text) || 0
  const bar = percent >= 80 ? 'bg-red-500' : percent >= 60 ? 'bg-yellow-500' : 'bg-primary-bright'
  const tone = percent >= 80 ? 'text-red-400' : percent >= 60 ? 'text-yellow-400' : 'text-slate-200'
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 h-2.5 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full transition-all duration-500 ${bar}`} style={{ width: `${Math.min(percent, 100)}%` }} />
      </div>
      <span className={`w-12 text-right font-medium tabular-nums ${tone}`} data-testid={testId}>{text}</span>
    </div>
  )
}

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
  const { open: openDetail } = useResourceDetail()
  const [search, setSearch] = useState('')

  // The node count comes from the node list, not from the metrics samples:
  // without metrics-server the metrics list is empty while the nodes exist.
  const { data: nodeList } = useQuery<any[]>({
    queryKey: ['nodes', currentCluster],
    queryFn: () => api.getNodes(),
    staleTime: 30000,
  })

  const { data: nodeMetrics, isLoading, error, dataUpdatedAt } = useQuery<NodeMetric[], Error>({
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

  const refreshFailure = useMemo(() => metricsRefreshFailure(error, nodeMetrics, dataUpdatedAt), [error, nodeMetrics, dataUpdatedAt])

  // kubectl top nodes lists every node, those the metrics-server has no sample for last with <unknown>: the cards are
  // the node list's nodes, one without a sample showing -, so the count, the cards and the pager agree
  const allNodes = useMemo(() => {
    const metrics = Array.isArray(nodeMetrics) ? nodeMetrics : []
    const seen = new Set(metrics.map((m) => m.name))
    const missing = (Array.isArray(nodeList) ? nodeList : [])
      .filter((n) => n?.name && !seen.has(n.name))
      .map((n): NodeMetric => ({ name: n.name, cpu: '-', cpu_percent: '-', memory: '-', memory_percent: '-' }))
    return [...metrics, ...missing]
  }, [nodeMetrics, nodeList])

  // 플로팅 AI 위젯용 스냅샷 — 노드 메트릭 요약
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(nodeMetrics)) return null
    const items = [...allNodes].sort(
      (a, b) => (parsePercent(b.cpu_percent) ?? 0) - (parsePercent(a.cpu_percent) ?? 0),
    )
    const highCpu = items.filter((n) => (parsePercent(n.cpu_percent) ?? 0) > 85)
    const highMem = items.filter((n) => (parsePercent(n.memory_percent) ?? 0) > 85)
    const prefix = highCpu.length > 0 || highMem.length > 0 ? '⚠️ ' : ''
    const summary = `${prefix}노드 모니터링 — ${items.length}개 노드 ${refreshFailure ? '사용량, 새로고침 실패로 옛 값' : '실시간 사용량'}`
    return {
      source: 'base' as const,
      summary,
      data: {
        tab: 'nodes',
        ...(refreshFailure ? { refresh_failed: refreshFailureForChat(refreshFailure) } : {}),
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
  }, [nodeMetrics, allNodes, refreshFailure])

  useAIContext(aiSnapshot, [aiSnapshot])

  const latestNodeMetricTime = getLatestMetricTimestamp(nodeMetrics)

  const filteredNodes = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? allNodes.filter((n) => n.name.toLowerCase().includes(q)) : allNodes
  }, [allNodes, search])
  // a page at a time in a box sized to the screen, as the list pages; a new search or cluster starts at the first page
  const { containerRef, bodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({ recalculationKey: filteredNodes.length })
  const { items: pagedNodes, page, totalPages, total, setPage } = usePagedItems(filteredNodes, rowsPerPage, `${search}|${currentCluster}`)
  const openNode = (name: string) => openDetail({ kind: 'Node', name })

  return (
    <div className="card flex-1 min-h-0 flex flex-col">
      <div className="flex items-start justify-between mb-6 shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-slate-700/60">
            <Server className="w-6 h-6 text-slate-300" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-ink">{t('monitoring.nodes.title')}</h2>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 text-right">
          {latestNodeMetricTime && (
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <div className={`w-2 h-2 rounded-full ${refreshFailure ? 'bg-amber-500' : 'bg-green-500'}`}></div>
              <span className="text-slate-400">{t('monitoring.autoRefresh')}</span>
            </div>
          )}
          {latestNodeMetricTime && (
            <p className="text-xs text-slate-400 flex items-center gap-2">
              <Clock className="w-4 h-4" />
              <span>
                {t('monitoring.metricTimestamp', { time: formatTime(latestNodeMetricTime) })}
              </span>
            </p>
          )}
          <p className="text-xs text-slate-500">{t('monitoring.fetchNote')}</p>
          {(nodeList || nodeMetrics) && (
            <p className="text-xs text-slate-400">
              {t('monitoring.nodes.total', { count: allNodes.length })}
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
        <div className="flex-1 min-h-0 flex flex-col">
        {refreshFailure && <MetricsRefreshFailed failure={refreshFailure} retrying={!metricsUnavailable} testId="node-metrics-refresh-failed" />}
        <MonitoringSearch value={search} onChange={setSearch} placeholder={t('monitoring.nodes.searchPlaceholder', 'Search nodes by name...')} testId="monitoring-node-search" />
        {/* one row a node, the columns kubectl top nodes prints */}
        <div ref={containerRef} className="flex-1 min-h-0 flex flex-col">
          <div ref={bodyRef} className="overflow-x-auto flex-1 min-h-0">
            <table className="w-full text-sm min-w-[760px] table-fixed">
              <thead ref={theadRef} className="text-slate-400">
                <tr>
                  <th className="text-left py-3 px-4">{t('monitoring.table.node', 'Node')}</th>
                  <th className="text-left py-3 px-4 w-[130px]">{t('monitoring.table.cpuUsage')}</th>
                  <th className="text-left py-3 px-4 w-[240px]">{t('monitoring.table.cpuPercent', 'CPU (% of allocatable)')}</th>
                  <th className="text-left py-3 px-4 w-[150px]">{t('monitoring.table.memoryUsage')}</th>
                  <th className="text-left py-3 px-4 w-[240px]">{t('monitoring.table.memoryPercent', 'Memory (% of allocatable)')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700">
                {pagedNodes.map((node, idx) => (
                  <tr
                    key={node.name}
                    ref={idx === 0 ? firstRowRef : undefined}
                    tabIndex={0}
                    onClick={() => openNode(node.name)}
                    // the row opens its Node from the keyboard too, as the card button it replaced did
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return
                      e.preventDefault()
                      openNode(node.name)
                    }}
                    data-testid="monitoring-node"
                    className="text-slate-200 hover:bg-slate-700/40 cursor-pointer focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-400"
                  >
                    <td className="py-3 px-4 font-medium text-ink">
                      <span className="flex items-center gap-2 min-w-0">
                        <Server className="w-4 h-4 text-slate-400 shrink-0" />
                        <span className="truncate" title={node.name}>{node.name}</span>
                      </span>
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-300">{node.cpu}</td>
                    <td className="py-3 px-4"><UsageCell text={node.cpu_percent} testId="monitoring-node-cpu-pct" /></td>
                    <td className="py-3 px-4 font-mono text-slate-300">{node.memory}</td>
                    <td className="py-3 px-4"><UsageCell text={node.memory_percent} testId="monitoring-node-memory-pct" /></td>
                  </tr>
                ))}
                {filteredNodes.length === 0 && (
                  <tr>
                    <td colSpan={COLUMNS} className="py-10 px-4 text-center text-slate-400" data-testid="monitoring-node-empty">{t('common.noSearchResults', 'No results found.')}</td>
                  </tr>
                )}
              </tbody>
              <AdaptiveTableFillerRows count={rowsPerPage - pagedNodes.length - (filteredNodes.length === 0 ? 1 : 0)} columnCount={COLUMNS} />
            </table>
          </div>
          <ListPager currentPage={page} totalPages={totalPages} total={total} rowsPerPage={rowsPerPage} onPageChange={setPage} testId="monitoring-node-pager" />
        </div>
        </div>
      ) : isForbiddenError(error) ? (
        <div className="text-center py-12">
          <p className="text-slate-400" data-testid="node-metrics-forbidden">
            {t('common.forbiddenEmpty', { resource: forbiddenResourceFromUrl('/cluster/metrics/nodes'), defaultValue: 'You do not have permission to view {{resource}} in this cluster.' })}
          </p>
        </div>
      ) : error && !isMetricsUnavailableError(error) ? (
        <div className="text-center py-12">
          <div className="flex flex-col items-center gap-4">
            <Activity className="w-12 h-12 text-red-400 animate-pulse" />
            <div>
              <p className="text-red-400 font-medium" data-testid="node-metrics-error">{t('monitoring.nodes.errorTitle')}</p>
              {(error as any).response?.data?.detail && <p className="text-sm text-slate-400 mt-2">{(error as any).response.data.detail}</p>}
              <p className="text-sm text-slate-500 mt-2">{t('monitoring.pods.retrying')}</p>
            </div>
          </div>
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
