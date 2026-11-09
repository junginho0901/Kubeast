// GPU Dashboard 의 Per-Node GPU Allocation 섹션 (좌측 2-col).
//
// 추출 출처: GPUDashboard.tsx (Phase 4.11) — gpu_nodes 별 used/allocatable 바 +
// 노드 row 클릭 시 ResourceDetail 열기. xl 그리드의 col-span-2 위치.

import { Link } from 'react-router-dom'
import { Server, ArrowRight } from 'lucide-react'
import { nodeStatusBadge, nodeStatusParts } from '@/utils/nodeStatus'
import type { GPUNodeVendor } from '@/services/api'
import { ListPager } from '@/components/ListPager'
import { usePagedItems } from '@/hooks/usePagedItems'
import { nodeVendorText } from '../gpuNumbers'

// Nodes per page of the section: the dashboard scrolls, so a fixed count (as the drawers' tables) rather than a fit
const NODE_ALLOCATION_PER_PAGE = 10

type NodeAllocItem = {
  name: string
  gpu_model?: string | null
  gpu_memory?: string | null
  gpu_capacity: number
  gpu_allocatable: number
  gpu_used: number
  gpu_vendors?: GPUNodeVendor[]
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
  const { items: pagedNodes, page, totalPages, total, setPage } = usePagedItems(nodeAllocation, NODE_ALLOCATION_PER_PAGE)
  return (
    <div className="xl:col-span-2 rounded-xl border border-slate-700/50 bg-slate-800/30 p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-slate-400" />
          <h2 className="text-sm font-semibold text-ink">
            {tr('gpuDashboardPage.nodeAllocation.title', 'Node GPU Allocation')}
          </h2>
          <span className="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300" data-testid="gpu-node-readiness">
            {nodeReadyCount} {tr('gpuDashboardPage.nodeAllocation.ready', 'ready')}
            {nodeNotReadyCount > 0 && (
              <span className="text-red-400"> / {nodeNotReadyCount} {tr('gpuDashboardPage.nodeAllocation.notReady', 'not ready')}</span>
            )}
          </span>
        </div>
        <Link
          to="/gpu/nodes"
          className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-ink transition-colors"
        >
          {tr('gpuDashboardPage.viewAll', 'View all')}
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      {nodeAllocation.length > 0 ? (
        <>
        <div className="space-y-3">
          {pagedNodes.map((node) => {
            const usedPct = node.gpu_allocatable > 0
              ? Math.round((node.gpu_used / node.gpu_allocatable) * 100)
              : 0
            return (
              <div
                key={node.name}
                data-testid="gpu-node-allocation"
                data-node={node.name}
                className="rounded-lg border border-slate-700/50 bg-slate-900/40 p-3 cursor-pointer hover:bg-slate-800/60 transition-colors"
                onClick={() => openDetail({ kind: 'Node', name: node.name })}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-ink">{node.name}</span>
                    {nodeStatusParts(node.status).map((part) => (
                      <span key={part} className={`badge ${nodeStatusBadge(part)}`}>{part}</span>
                    ))}
                  </div>
                  {/* each company's GPUs of the node: its name (unless the model starts with it), model and memory */}
                  <span className="text-xs text-slate-400" data-testid="gpu-node-allocation-models">
                    {(node.gpu_vendors ?? []).map((v) => nodeVendorText(v, tr('common.unknown', 'Unknown'))).join(' / ')}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-2.5 bg-slate-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        usedPct >= 80 ? 'bg-red-500' : usedPct >= 50 ? 'bg-amber-500' : 'bg-primary-bright'
                      }`}
                      style={{ width: `${Math.min(usedPct, 100)}%` }}
                    />
                  </div>
                  <span className="text-xs font-mono text-slate-300 whitespace-nowrap" data-testid="gpu-node-allocation-value">
                    {node.gpu_used}/{node.gpu_allocatable}
                    <span className="text-slate-500 ml-1">({usedPct}%)</span>
                  </span>
                </div>
              </div>
            )
          })}
        </div>
        <div className="mt-3">
          <ListPager currentPage={page} totalPages={totalPages} total={total} rowsPerPage={NODE_ALLOCATION_PER_PAGE} onPageChange={setPage} showPageSize={false} testId="gpu-node-allocation-pager" />
        </div>
        </>
      ) : (
        <p className="text-sm text-slate-400">{tr('gpuDashboardPage.nodeAllocation.empty', 'No GPU nodes available.')}</p>
      )}
    </div>
  )
}
