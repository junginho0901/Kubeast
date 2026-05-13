// GPU Dashboard 의 Real-time GPU Metrics 섹션 — Prometheus/DCGM 기반.
//   - Avg GPU Util / Avg Memory Util / Memory Used / Physical GPUs 4 카드
//   - Per-GPU bars grouped by host (Core / Mem / Temp / Pod 정보)
//
// 추출 출처: GPUDashboard.tsx (Phase 4.11) — metricsAvailable && metrics 일 때만
// 렌더. 본체에서는 한 줄로 호출.

import { Activity } from 'lucide-react'
import type { GPUMetricsData, GPUDeviceMetric } from '@/services/api'

interface Props {
  metricsAvailable: boolean
  metrics: GPUMetricsData | undefined
  gpusByHost: Map<string, GPUDeviceMetric[]>
  tr: (key: string, fallback: string) => string
}

export function RealtimeMetricsSection({ metricsAvailable, metrics, gpusByHost, tr }: Props) {
  if (!metricsAvailable || !metrics) return null

  return (
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
  )
}
