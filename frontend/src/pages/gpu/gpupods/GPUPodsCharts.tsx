// GPUPods 페이지의 차트 패널 (GPU Usage per Node + Status Distribution)
//
// frontend/src/pages/gpu/GPUPods.tsx 의 showCharts 토글 패널 추출.
// 두 카드: ① 노드별 GPU 사용량 전부 (totalGpu 내림차순) ②
// status 분포 전부 (count 내림차순) — bar 색상 status 별 분기.

import { Box } from 'lucide-react'
import { ListPager } from '@/components/ListPager'
import { usePagedItems } from '@/hooks/usePagedItems'
import { gpuPodStatusBar } from '../gpuNumbers'

// Nodes per page of GPU Usage by Node: the panel sits above the table, so a fixed count (as the drawers' tables)
const NODE_USAGE_PER_PAGE = 10

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
  const { items: pagedNodes, page, totalPages, total: nodeTotal, setPage } = usePagedItems(nodeGpuUsage, NODE_USAGE_PER_PAGE)
  if (nodeGpuUsage.length === 0 && topStatuses.length === 0) return null

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 shrink-0">
      {nodeGpuUsage.length > 0 && (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-ink">
              {tr('gpuPods.nodeUsage', 'GPU Usage by Node')}
            </h2>
            <Box className="w-4 h-4 text-slate-400" />
          </div>
          <div className="space-y-3">
            {pagedNodes.map(([node, info]) => (
              <div key={node} className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-900/40 px-4 py-2.5" data-testid="gpu-pods-node-usage" data-node={node}>
                <div>
                  <span className="text-sm font-medium text-ink">{node || tr('gpuPods.noNode', 'Not scheduled')}</span>
                  <span className="ml-2 text-xs text-slate-400">
                    {info.podCount === 1 ? tr('gpuPods.podCountOne', '{{n}} pod', { n: info.podCount }) : tr('gpuPods.podCount', '{{n}} pods', { n: info.podCount })}
                  </span>
                </div>
                <span className="text-sm font-semibold text-slate-200">
                  {info.totalGpu} GPU{info.totalGpu !== 1 ? 's' : ''}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-3">
            <ListPager currentPage={page} totalPages={totalPages} total={nodeTotal} rowsPerPage={NODE_USAGE_PER_PAGE} onPageChange={setPage} showPageSize={false} testId="gpu-pods-node-usage-pager" />
          </div>
        </div>
      )}

      {topStatuses.length > 0 && (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-ink">
              {tr('gpuPods.statusDistribution', 'Status Distribution')}
            </h2>
          </div>
          <div className="space-y-3">
            {topStatuses.map(([status, count]) => {
              const pct = total > 0 ? Math.round((count / total) * 100) : 0
              return (
                <div key={status} data-testid="gpu-pods-status-row">
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="text-slate-300">{status}</span>
                    <span className="text-xs text-slate-400">{count} ({pct}%)</span>
                  </div>
                  <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${gpuPodStatusBar(status, 'bg-slate-500')}`}
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
