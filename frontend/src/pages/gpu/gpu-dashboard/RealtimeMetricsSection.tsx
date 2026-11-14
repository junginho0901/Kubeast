// GPU Dashboard 의 Real-time GPU Metrics 섹션 — Prometheus/DCGM 기반.
//   - Avg GPU Util / Avg Memory Util / Memory Used / Physical GPUs 4 카드
//   - Per-GPU bars grouped by host (Core / Mem / Temp / Pod 정보)
//
// 추출 출처: GPUDashboard.tsx (Phase 4.11) — metricsAvailable && metrics 일 때만
// 렌더. 본체에서는 한 줄로 호출.

import { useMemo } from 'react'
import { Activity } from 'lucide-react'
import type { GPUMetricsData, GPUDeviceMetric } from '@/services/api'
import { ListPager } from '@/components/ListPager'
import { usePagedItems } from '@/hooks/usePagedItems'
import { failureText } from '@/utils/failureText'
import { gpuPercentText, gpuRealtimeAverages, gpusReportingUtil, gpuSeriesPod, hostsByName } from '../gpuNumbers'

// Hosts per page of the section (a host of 8 GPUs is about 250px): the dashboard scrolls, so a fixed count
const REALTIME_HOSTS_PER_PAGE = 4

interface Props {
  metricsAvailable: boolean
  // the metrics read's error when the cluster's Prometheus is set but did not answer
  metricsFailure?: unknown
  metrics: GPUMetricsData | undefined
  gpusByHost: Map<string, GPUDeviceMetric[]>
  // namespace/name of the pods that ask for a GPU or hold a DRA claim's devices (gpuHolderPods): a GPU's pod is named
  // only when it is one of them
  gpuPodKeys: Set<string>
  tr: (key: string, fallback: string, options?: Record<string, unknown>) => string
}

export function RealtimeMetricsSection({ metricsAvailable, metricsFailure = null, metrics, gpusByHost, gpuPodKeys, tr }: Props) {
  const hosts = useMemo(() => hostsByName(gpusByHost), [gpusByHost])
  const { items: pagedHosts, page, totalPages, total, setPage } = usePagedItems(hosts, REALTIME_HOSTS_PER_PAGE)
  if (!metricsAvailable && metricsFailure) {
    return (
      <div className="rounded-xl border border-slate-700/50 bg-slate-800/30 p-5" data-testid="gpu-realtime-not-answering">
        <h2 className="text-sm font-semibold text-ink mb-2">{tr('gpuDashboardPage.realtime.title', 'Real-time GPU Metrics')}</h2>
        <p className="text-xs text-slate-400">{tr('gpuDashboardPage.realtime.notAnswering', 'Prometheus did not answer: {{reason}}', { reason: failureText(metricsFailure) })}</p>
      </div>
    )
  }
  if (!metricsAvailable || !metrics) return null
  const podOf = (gpu: GPUDeviceMetric) => gpuSeriesPod(gpu, gpuPodKeys)
  const { util, memory } = gpuRealtimeAverages(metrics)
  const memoryUsedMb = metrics.total_memory_used_mb ?? 0
  const memoryTotalMb = metrics.total_memory_mb ?? 0
  const reportingUtil = gpusReportingUtil(metrics.gpus ?? [])
  // what the average leaves out, on the card only while it leaves some GPUs out and has others to average
  const utilTitle = reportingUtil > 0 && reportingUtil < (metrics.gpu_count ?? 0)
    ? tr('gpuDashboardPage.realtime.avgUtilOf', 'The {{n}} of {{total}} GPUs that report utilization', { n: reportingUtil, total: metrics.gpu_count })
    : undefined

  return (
    <div className="rounded-xl border border-slate-700/50 bg-slate-800/30 p-5" data-testid="gpu-realtime">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-slate-400" />
          <h2 className="text-sm font-semibold text-ink">
            {tr('gpuDashboardPage.realtime.title', 'Real-time GPU Metrics')}
          </h2>
          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-400 ring-1 ring-emerald-500/20">
            {tr('gpuDashboardPage.realtime.live', 'Live')}
          </span>
        </div>
        <span className="text-xs text-slate-500" data-testid="gpu-realtime-detected">
          {tr(metrics.gpu_count === 1 ? 'gpuDashboardPage.realtime.detectedOne' : 'gpuDashboardPage.realtime.detected', metrics.gpu_count === 1 ? '{{n}} GPU detected' : '{{n}} GPUs detected', { n: metrics.gpu_count })}
        </span>
      </div>

      {/* Avg metrics summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div className="rounded-lg border border-slate-700/50 bg-slate-900/40 px-3 py-2.5">
          <div className="text-[11px] text-slate-400">{tr('gpuDashboardPage.realtime.avgUtil', 'Avg GPU Utilization')}</div>
          <div className="mt-1 text-lg font-semibold text-ink" data-testid="gpu-realtime-avg-util" title={utilTitle}>{gpuPercentText(util)}</div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
            <div
              className={`h-full rounded-full ${(util ?? 0) >= 80 ? 'bg-red-500' : (util ?? 0) >= 50 ? 'bg-amber-500' : 'bg-primary-bright'}`}
              style={{ width: `${Math.min(util ?? 0, 100)}%` }}
            />
          </div>
        </div>
        <div className="rounded-lg border border-slate-700/50 bg-slate-900/40 px-3 py-2.5">
          <div className="text-[11px] text-slate-400">{tr('gpuDashboardPage.realtime.avgMemUtil', 'Avg Memory Utilization')}</div>
          <div className="mt-1 text-lg font-semibold text-ink" data-testid="gpu-realtime-avg-mem">{gpuPercentText(memory)}</div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
            <div
              className={`h-full rounded-full ${(memory ?? 0) >= 80 ? 'bg-red-500' : (memory ?? 0) >= 50 ? 'bg-amber-500' : 'bg-primary-bright'}`}
              style={{ width: `${Math.min(memory ?? 0, 100)}%` }}
            />
          </div>
        </div>
        <div className="rounded-lg border border-slate-700/50 bg-slate-900/40 px-3 py-2.5">
          <div className="text-[11px] text-slate-400">{tr('gpuDashboardPage.realtime.memUsed', 'Memory Used')}</div>
          <div className="mt-1 text-lg font-semibold text-ink" data-testid="gpu-realtime-mem-used">
            {memoryTotalMb > 0 ? `${(memoryUsedMb / 1024).toFixed(1)} GiB` : '-'}
          </div>
          <div className="text-[11px] text-slate-500" data-testid="gpu-realtime-mem-total">
            / {memoryTotalMb > 0 ? `${(memoryTotalMb / 1024).toFixed(1)} GiB` : '-'}
          </div>
        </div>
        <div className="rounded-lg border border-slate-700/50 bg-slate-900/40 px-3 py-2.5">
          <div className="text-[11px] text-slate-400">{tr('gpuDashboardPage.realtime.gpuCount', 'Physical GPUs')}</div>
          <div className="mt-1 text-lg font-semibold text-ink" data-testid="gpu-realtime-count">{(metrics.gpu_count ?? 0) > 0 ? metrics.gpu_count : '-'}</div>
        </div>
      </div>

      {/* Per-GPU bars by host, a page of hosts at a time */}
      <div className="space-y-3">
        {pagedHosts.map(([hostname, gpus]) => (
          <div key={hostname} className="rounded-lg border border-slate-700/50 bg-slate-900/40 p-3" data-testid="gpu-realtime-host" data-host={hostname}>
            <div className="text-xs font-medium text-slate-300 mb-2">{hostname}</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {gpus.map((gpu) => (
                <div key={gpu.uuid} className="space-y-1.5" data-testid="gpu-realtime-gpu" data-uuid={gpu.uuid}>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-400">
                      GPU {gpu.gpu} {gpu.model_name ? `(${gpu.model_name})` : ''}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-slate-500 w-8">{tr('gpuDashboardPage.realtime.core', 'Core')}</span>
                    <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${(gpu.gpu_util ?? 0) >= 80 ? 'bg-red-500' : (gpu.gpu_util ?? 0) >= 50 ? 'bg-amber-500' : 'bg-primary-bright'}`}
                        style={{ width: `${Math.min(gpu.gpu_util ?? 0, 100)}%` }}
                      />
                    </div>
                    <span className="text-[10px] font-mono text-slate-300 w-10 text-right" data-testid="gpu-realtime-core">{gpuPercentText(gpu.gpu_util)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-slate-500 w-8">{tr('gpuDashboardPage.realtime.mem', 'Mem')}</span>
                    <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${(gpu.memory_util_percent ?? 0) >= 80 ? 'bg-red-500' : (gpu.memory_util_percent ?? 0) >= 50 ? 'bg-amber-500' : 'bg-primary-bright'}`}
                        style={{ width: `${Math.min(gpu.memory_util_percent ?? 0, 100)}%` }}
                      />
                    </div>
                    <span className="text-[10px] font-mono text-slate-300 w-10 text-right" data-testid="gpu-realtime-mem">{gpuPercentText(gpu.memory_util_percent)}</span>
                  </div>
                  {((gpu.memory_temp ?? 0) > 0 || podOf(gpu)) && (
                    <div className="text-[10px] text-slate-500">
                      {gpu.memory_temp !== null && gpu.memory_temp > 0 && (
                        <span className="mr-2" data-testid="gpu-realtime-temp">
                          {tr('gpuDashboardPage.realtime.temp', 'Temp')}: <span className={gpu.memory_temp >= 85 ? 'text-red-400' : gpu.memory_temp >= 70 ? 'text-amber-400' : 'text-slate-400'}>{gpu.memory_temp}°C</span>
                        </span>
                      )}
                      {podOf(gpu) && <span data-testid="gpu-realtime-pod">{tr('gpuDashboardPage.realtime.pod', 'Pod')}: {podOf(gpu)}</span>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {hosts.length > 0 && (
        <div className="mt-3">
          <ListPager currentPage={page} totalPages={totalPages} total={total} rowsPerPage={REALTIME_HOSTS_PER_PAGE} onPageChange={setPage} showPageSize={false} testId="gpu-realtime-pager" />
        </div>
      )}
    </div>
  )
}
