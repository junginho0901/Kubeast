import { useTranslation } from 'react-i18next'
import { Monitor } from 'lucide-react'

interface ModelEntry {
  count: number
  totalCapacity: number
  totalAllocatable: number
}

interface Props {
  modelDistribution: Array<[string, ModelEntry]>
}

export default function GPUNodesModelDistribution({ modelDistribution }: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })

  if (modelDistribution.length === 0) return null

  return (
    <div className="card shrink-0">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-white">
          {tr('gpuNodes.modelDistribution', 'GPU Model Distribution')}
        </h2>
        <Monitor className="w-4 h-4 text-slate-400" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {modelDistribution.map(([model, info]) => {
          const utilization = info.totalAllocatable > 0
            ? Math.round(((info.totalCapacity - info.totalAllocatable) / info.totalCapacity) * 100)
            : 0
          return (
            <div key={model} className="rounded-lg border border-slate-700 bg-slate-900/40 px-4 py-3">
              <div className="flex items-center justify-between text-sm text-white">
                <span className="font-medium truncate">{model}</span>
                <span className="text-xs text-slate-400 ml-2 whitespace-nowrap">
                  {info.count} {info.count === 1 ? 'node' : 'nodes'}
                </span>
              </div>
              <div className="mt-3 space-y-2">
                <div className="text-xs text-slate-400 flex items-center justify-between">
                  <span>{tr('gpuNodes.capacity', 'Capacity')}</span>
                  <span className="font-medium text-blue-300">{info.totalCapacity}</span>
                </div>
                <div className="text-xs text-slate-400 flex items-center justify-between">
                  <span>{tr('gpuNodes.allocatable', 'Allocatable')}</span>
                  <span className="font-medium text-cyan-300">{info.totalAllocatable}</span>
                </div>
                <div className="w-full h-2.5 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${utilization >= 80 ? 'bg-red-500' : utilization >= 60 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                    style={{ width: `${Math.min(utilization, 100)}%` }}
                  />
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
