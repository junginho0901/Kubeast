import { useMemo } from 'react'
import { Server } from 'lucide-react'
import type { NodeMetric } from './clusterNodeHelpers'

interface Props {
  metrics: NodeMetric[] | undefined
  metricsAvailable: boolean
  isLoadingMetrics: boolean
  isMetricsError: boolean
  tr: (key: string, fallback: string, options?: Record<string, any>) => string
}

export default function NodeTopUsageCard({
  metrics,
  metricsAvailable,
  isLoadingMetrics,
  isMetricsError,
  tr,
}: Props) {
  const topNodes = useMemo(() => {
    if (!Array.isArray(metrics) || metrics.length === 0) return [] as NodeMetric[]
    const parsePercent = (value: string | undefined) => {
      if (!value) return 0
      const numeric = Number(String(value).replace('%', ''))
      return Number.isFinite(numeric) ? numeric : 0
    }
    return [...metrics]
      .map((node) => {
        const cpuPercent = parsePercent(node.cpu_percent)
        const memPercent = parsePercent(node.memory_percent)
        return {
          ...node,
          _score: cpuPercent * 0.7 + memPercent * 0.3,
        } as NodeMetric & { _score: number }
      })
      .sort((a, b) => b._score - a._score)
      .slice(0, 3)
  }, [metrics])

  return (
    <div className="card shrink-0">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-white">
          {tr('nodes.top.title', 'Top nodes by resource usage')}
        </h2>
        <Server className="w-4 h-4 text-slate-400" />
      </div>
      {!metricsAvailable ? (
        <p className="text-sm text-slate-400">{tr('nodes.top.unavailable', 'Metrics server not available for this cluster')}</p>
      ) : isLoadingMetrics ? (
        <p className="text-sm text-slate-400">{tr('nodes.top.loading', 'Loading metrics...')}</p>
      ) : isMetricsError ? (
        <p className="text-sm text-slate-400">{tr('nodes.top.error', 'Metrics unavailable')}</p>
      ) : topNodes.length > 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {topNodes.map((node, index) => {
            const cpuPercent = parseFloat(node.cpu_percent)
            const memPercent = parseFloat(node.memory_percent)
            return (
              <div key={node.name} className="rounded-lg border border-slate-700 bg-slate-900/40 px-4 py-3">
                <div className="flex items-center justify-between text-sm text-white">
                  <span className="font-medium">#{index + 1} {node.name}</span>
                  <span className="text-xs text-slate-400">{node.cpu} / {node.memory}</span>
                </div>
                <div className="mt-3 space-y-2">
                  <div className="text-xs text-slate-400 flex items-center justify-between">
                    <span>CPU</span>
                    <span className="font-medium text-emerald-300">{node.cpu_percent}</span>
                  </div>
                  <div className="w-full h-2.5 bg-slate-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${cpuPercent >= 80 ? 'bg-red-500' : cpuPercent >= 60 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                      style={{ width: `${Math.min(cpuPercent, 100)}%` }}
                    />
                  </div>
                  <div className="text-xs text-slate-400 flex items-center justify-between">
                    <span>MEM</span>
                    <span className="font-medium text-blue-300">{node.memory_percent}</span>
                  </div>
                  <div className="w-full h-2.5 bg-slate-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${memPercent >= 80 ? 'bg-red-500' : memPercent >= 60 ? 'bg-amber-500' : 'bg-blue-500'}`}
                      style={{ width: `${Math.min(memPercent, 100)}%` }}
                    />
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <p className="text-sm text-slate-400">{tr('nodes.top.empty', 'No metrics available')}</p>
      )}
    </div>
  )
}
