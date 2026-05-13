// GPU Dashboard 의 우측 col — GPU Model Distribution + Pod Status Distribution.
//
// 추출 출처: GPUDashboard.tsx (Phase 4.11) — modelDistribution / podStatusDist
// 데이터 시각화. xl 그리드 우측 1-col (NodeAllocationSection 의 col-span-2 옆).

import { Link } from 'react-router-dom'
import { Monitor, Box, ArrowRight } from 'lucide-react'
import type { GPUDashboardData } from '@/services/api'
import { getStatusColor } from './helpers'

interface Props {
  data: GPUDashboardData
  modelDistribution: [string, number][]
  podStatusDist: [string, number][]
  tr: (key: string, fallback: string) => string
}

export function DistributionsSection({ data, modelDistribution, podStatusDist, tr }: Props) {
  return (
    <div className="flex flex-col gap-4">
      {/* GPU Model Distribution */}
      <div className="rounded-xl border border-slate-700/50 bg-slate-800/30 p-5">
        <div className="flex items-center gap-2 mb-4">
          <Monitor className="h-4 w-4 text-slate-400" />
          <h2 className="text-sm font-semibold text-white">
            {tr('gpuDashboardPage.modelDist.title', 'GPU Models')}
          </h2>
        </div>
        {modelDistribution.length > 0 ? (
          <div className="space-y-3">
            {modelDistribution.map(([model, gpuCount]) => {
              const pct = data.total_gpu_capacity > 0
                ? Math.round((gpuCount / data.total_gpu_capacity) * 100)
                : 0
              return (
                <div key={model}>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="text-slate-300 truncate">{model}</span>
                    <span className="text-xs text-slate-400 ml-2 whitespace-nowrap">{gpuCount} GPU ({pct}%)</span>
                  </div>
                  <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                    <div className="h-full rounded-full bg-blue-500" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="text-sm text-slate-400">{tr('gpuDashboardPage.modelDist.empty', 'No GPU models detected.')}</p>
        )}
      </div>

      {/* Pod Status Distribution */}
      <div className="rounded-xl border border-slate-700/50 bg-slate-800/30 p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Box className="h-4 w-4 text-slate-400" />
            <h2 className="text-sm font-semibold text-white">
              {tr('gpuDashboardPage.podStatus.title', 'Pod Status')}
            </h2>
            <span className="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">
              {data.gpu_pods.length}
            </span>
          </div>
          <Link
            to="/gpu/pods"
            className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-white transition-colors"
          >
            {tr('gpuDashboardPage.viewAll', 'View all')}
            <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
        {podStatusDist.length > 0 ? (
          <div className="space-y-2">
            {podStatusDist.map(([status, count]) => {
              const pct = data.gpu_pods.length > 0
                ? Math.round((count / data.gpu_pods.length) * 100)
                : 0
              return (
                <div key={status} className="flex items-center gap-3">
                  <span className={`badge ${getStatusColor(status)} w-24 justify-center`}>{status}</span>
                  <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
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
                  <span className="text-xs text-slate-400 w-16 text-right">{count} ({pct}%)</span>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="text-sm text-slate-400">{tr('gpuDashboardPage.podStatus.empty', 'No GPU pods running.')}</p>
        )}
      </div>
    </div>
  )
}
