import { useTranslation } from 'react-i18next'
import type { GPUDeviceMetric } from '@/services/api'

interface Props {
  gpusByHost: Map<string, GPUDeviceMetric[]>
}

export default function GPUNodesRealtimeMetrics({ gpusByHost }: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })

  if (gpusByHost.size === 0) return null

  return (
    <div className="card shrink-0">
      <div className="flex items-center gap-2 mb-4">
        <div className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
        <h2 className="text-sm font-semibold text-white">
          {tr('gpuNodes.realtimeMetrics', 'Real-time GPU Utilization')}
        </h2>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {[...gpusByHost.entries()].map(([hostname, gpus]) => {
          const avgUtil = gpus.reduce((s, g) => s + g.gpu_util, 0) / gpus.length
          const avgMem = gpus.reduce((s, g) => s + g.memory_util_percent, 0) / gpus.length
          return (
            <div key={hostname} className="rounded-lg border border-slate-700 bg-slate-900/40 px-4 py-3">
              <div className="flex items-center justify-between text-sm text-white mb-3">
                <span className="font-medium">{hostname}</span>
                <span className="text-xs text-slate-400">{gpus.length} GPU{gpus.length !== 1 ? 's' : ''}</span>
              </div>
              <div className="space-y-2">
                {gpus.map((gpu) => (
                  <div key={gpu.uuid} className="flex items-center gap-3">
                    <span className="text-xs text-slate-400 w-16 shrink-0">GPU {gpu.gpu}</span>
                    <div className="flex-1 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-slate-500 w-7">Core</span>
                        <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${gpu.gpu_util >= 80 ? 'bg-red-500' : gpu.gpu_util >= 50 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                            style={{ width: `${Math.min(gpu.gpu_util, 100)}%` }}
                          />
                        </div>
                        <span className="text-[10px] font-mono text-slate-300 w-10 text-right">{Math.round(gpu.gpu_util)}%</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-slate-500 w-7">Mem</span>
                        <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${gpu.memory_util_percent >= 80 ? 'bg-red-500' : gpu.memory_util_percent >= 50 ? 'bg-amber-500' : 'bg-blue-500'}`}
                            style={{ width: `${Math.min(gpu.memory_util_percent, 100)}%` }}
                          />
                        </div>
                        <span className="text-[10px] font-mono text-slate-300 w-10 text-right">{Math.round(gpu.memory_util_percent)}%</span>
                      </div>
                    </div>
                    {gpu.memory_temp > 0 && (
                      <span className={`text-[10px] w-10 text-right ${gpu.memory_temp >= 85 ? 'text-red-400' : gpu.memory_temp >= 70 ? 'text-amber-400' : 'text-slate-400'}`}>
                        {gpu.memory_temp}°C
                      </span>
                    )}
                  </div>
                ))}
              </div>
              <div className="mt-2 pt-2 border-t border-slate-700/50 flex gap-4 text-[10px] text-slate-500">
                <span>Avg Core: {Math.round(avgUtil)}%</span>
                <span>Avg Mem: {Math.round(avgMem)}%</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
