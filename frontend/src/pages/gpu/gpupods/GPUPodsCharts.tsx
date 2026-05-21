// GPUPods 페이지의 차트 패널 (GPU Usage per Node + Status Distribution)
//
// frontend/src/pages/gpu/GPUPods.tsx 의 showCharts 토글 패널 추출.
// 두 카드: ① 노드별 GPU 사용량 top 4 (totalGpu 내림차순) ②
// status 분포 top 5 (count 내림차순) — bar 색상 status 별 분기.

import { Box } from 'lucide-react'

interface NodeUsageEntry {
  podCount: number
  totalGpu: number
}

interface Props {
  nodeGpuUsage: Array<[string, NodeUsageEntry]>
  topStatuses: Array<[string, number]>
  total: number
  tr: (key: string, fallback: string, options?: Record<string, any>) => string
}

export function GPUPodsCharts({
  nodeGpuUsage,
  topStatuses,
  total,
  tr,
}: Props) {
  if (nodeGpuUsage.length === 0 && topStatuses.length === 0) return null

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 shrink-0">
      {nodeGpuUsage.length > 0 && (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-white">
              {tr('gpuPods.nodeUsage', 'GPU Usage by Node')}
            </h2>
            <Box className="w-4 h-4 text-slate-400" />
          </div>
          <div className="space-y-3">
            {nodeGpuUsage.map(([node, info]) => (
              <div key={node} className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-900/40 px-4 py-2.5">
                <div>
                  <span className="text-sm font-medium text-white">{node}</span>
                  <span className="ml-2 text-xs text-slate-400">
                    {info.podCount} {info.podCount === 1 ? 'pod' : 'pods'}
                  </span>
                </div>
                <span className="text-sm font-semibold text-violet-300">
                  {info.totalGpu} GPU{info.totalGpu !== 1 ? 's' : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {topStatuses.length > 0 && (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-white">
              {tr('gpuPods.statusDistribution', 'Status Distribution')}
            </h2>
          </div>
          <div className="space-y-3">
            {topStatuses.map(([status, count]) => {
              const pct = total > 0 ? Math.round((count / total) * 100) : 0
              return (
                <div key={status}>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="text-slate-300">{status}</span>
                    <span className="text-xs text-slate-400">{count} ({pct}%)</span>
                  </div>
                  <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${
                        status === 'Running' ? 'bg-emerald-500'
                        : status === 'Pending' ? 'bg-yellow-500'
                        : status === 'Succeeded' ? 'bg-blue-500'
                        : status === 'Failed' ? 'bg-red-500'
                        : 'bg-slate-500'
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
