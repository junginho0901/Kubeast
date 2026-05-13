// GPU Dashboard 의 Per-Node GPU Allocation 섹션 (좌측 2-col).
//
// 추출 출처: GPUDashboard.tsx (Phase 4.11) — gpu_nodes 별 used/allocatable 바 +
// 노드 row 클릭 시 ResourceDetail 열기. xl 그리드의 col-span-2 위치.

import { Link } from 'react-router-dom'
import { Server, ArrowRight } from 'lucide-react'
import { getStatusColor } from './helpers'

type NodeAllocItem = {
  name: string
  gpu_model?: string | null
  gpu_memory?: string | null
  gpu_capacity: number
  gpu_allocatable: number
  gpu_used: number
  status: string
}

interface Props {
  nodeAllocation: NodeAllocItem[]
  nodeReadyCount: number
  nodeNotReadyCount: number
  openDetail: (target: { kind: string; name: string; namespace?: string }) => void
  tr: (key: string, fallback: string) => string
}

export function NodeAllocationSection({ nodeAllocation, nodeReadyCount, nodeNotReadyCount, openDetail, tr }: Props) {
  return (
    <div className="xl:col-span-2 rounded-xl border border-slate-700/50 bg-slate-800/30 p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-slate-400" />
          <h2 className="text-sm font-semibold text-white">
            {tr('gpuDashboardPage.nodeAllocation.title', 'Node GPU Allocation')}
          </h2>
          <span className="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">
            {nodeReadyCount} {tr('gpuDashboardPage.nodeAllocation.ready', 'ready')}
            {nodeNotReadyCount > 0 && (
              <span className="text-red-400"> / {nodeNotReadyCount} {tr('gpuDashboardPage.nodeAllocation.notReady', 'not ready')}</span>
            )}
          </span>
        </div>
        <Link
          to="/gpu/nodes"
          className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-white transition-colors"
        >
          {tr('gpuDashboardPage.viewAll', 'View all')}
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      {nodeAllocation.length > 0 ? (
        <div className="space-y-3">
          {nodeAllocation.map((node) => {
            const usedPct = node.gpu_allocatable > 0
              ? Math.round((node.gpu_used / node.gpu_allocatable) * 100)
              : 0
            return (
              <div
                key={node.name}
                className="rounded-lg border border-slate-700/50 bg-slate-900/40 p-3 cursor-pointer hover:bg-slate-800/60 transition-colors"
                onClick={() => openDetail({ kind: 'Node', name: node.name })}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-white">{node.name}</span>
                    <span className={`badge ${getStatusColor(node.status)}`}>{node.status}</span>
                  </div>
                  <span className="text-xs text-slate-400">
                    {node.gpu_model ?? 'Unknown'} {node.gpu_memory ? `• ${node.gpu_memory}` : ''}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-2.5 bg-slate-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        usedPct >= 80 ? 'bg-red-500' : usedPct >= 50 ? 'bg-amber-500' : 'bg-emerald-500'
                      }`}
                      style={{ width: `${Math.min(usedPct, 100)}%` }}
                    />
                  </div>
                  <span className="text-xs font-mono text-slate-300 whitespace-nowrap">
                    {node.gpu_used}/{node.gpu_allocatable}
                    <span className="text-slate-500 ml-1">({usedPct}%)</span>
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <p className="text-sm text-slate-400">{tr('gpuDashboardPage.nodeAllocation.empty', 'No GPU nodes available.')}</p>
      )}
    </div>
  )
}
