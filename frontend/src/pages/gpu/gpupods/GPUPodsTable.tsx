// GPUPods 목록 테이블 + sort 헤더 + pagination
//
// frontend/src/pages/gpu/GPUPods.tsx 의 table JSX (sort header + tbody +
// 빈/로딩 상태 + metrics 컬럼 + pagination footer) 추출. useAdaptiveTable
// 의 ref/rowsPerPage 는 부모에서 hook 호출 후 props 로 전달.
// 6 sortable 컬럼 (namespace + name + node + GPUs + status + age) +
// 2 optional 컬럼 (GPU Util + Mem Util, metricsAvailable 일 때만).
// min-w-[980px].

import type { Dispatch, RefObject, SetStateAction } from 'react'
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import type { GPUPodInfo } from '@/services/api'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { formatAge, getStatusColor, type SortKey } from './gpuPodsHelpers'

interface PodMetric {
  gpu_util: number
  memory_util_percent: number
  memory_used_mb: number
  memory_total_mb: number
  model_name: string
}

interface OpenDetailArgs {
  kind: string
  name: string
  namespace: string
}

interface Props {
  pagedPods: GPUPodInfo[]
  sortedPodsLength: number
  isLoading: boolean
  metricsAvailable: boolean
  podMetricsMap: Map<string, PodMetric>
  showCharts: boolean
  sortKey: SortKey
  setSortKey: Dispatch<SetStateAction<SortKey>>
  sortDir: 'asc' | 'desc'
  setSortDir: Dispatch<SetStateAction<'asc' | 'desc'>>
  currentPage: number
  setCurrentPage: Dispatch<SetStateAction<number>>
  totalPages: number
  rowsPerPage: number
  tableContainerRef: RefObject<HTMLDivElement>
  tableBodyRef: RefObject<HTMLDivElement>
  theadRef: RefObject<HTMLTableSectionElement>
  firstRowRef: RefObject<HTMLTableRowElement>
  openDetail: (args: OpenDetailArgs) => void
  tr: (key: string, fallback: string, options?: Record<string, any>) => string
}

export function GPUPodsTable({
  pagedPods,
  sortedPodsLength,
  isLoading,
  metricsAvailable,
  podMetricsMap,
  showCharts,
  sortKey,
  setSortKey,
  sortDir,
  setSortDir,
  currentPage,
  setCurrentPage,
  totalPages,
  rowsPerPage,
  tableContainerRef,
  tableBodyRef,
  theadRef,
  firstRowRef,
  openDetail,
  tr,
}: Props) {
  const handleSort = (key: NonNullable<SortKey>) => {
    if (sortKey !== key) {
      setSortKey(key)
      setSortDir('asc')
      return
    }
    if (sortDir === 'asc') {
      setSortDir('desc')
      return
    }
    setSortKey(null)
  }

  const renderSortIcon = (key: NonNullable<SortKey>) => {
    if (sortKey !== key) return null
    return sortDir === 'asc' ? (
      <ChevronUp className="w-3.5 h-3.5 text-slate-300" />
    ) : (
      <ChevronDown className="w-3.5 h-3.5 text-slate-300" />
    )
  }

  return (
    <div ref={tableContainerRef} className={`card flex flex-col ${showCharts ? 'min-h-[420px]' : 'flex-1 min-h-0'}`}>
      <div ref={tableBodyRef} className="overflow-x-auto flex-1 min-h-0">
        <table className="w-full text-sm min-w-[980px] table-fixed">
          <thead ref={theadRef} className="text-slate-400">
            <tr>
              <th className="text-left py-3 px-4 w-[150px] cursor-pointer" onClick={() => handleSort('namespace')}>
                <span className="inline-flex items-center gap-1">{tr('gpuPods.table.namespace', 'Namespace')}{renderSortIcon('namespace')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[260px] cursor-pointer" onClick={() => handleSort('name')}>
                <span className="inline-flex items-center gap-1">{tr('gpuPods.table.name', 'Name')}{renderSortIcon('name')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[200px] cursor-pointer" onClick={() => handleSort('node_name')}>
                <span className="inline-flex items-center gap-1">{tr('gpuPods.table.node', 'Node')}{renderSortIcon('node_name')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('gpu_requested')}>
                <span className="inline-flex items-center gap-1">{tr('gpuPods.table.gpus', 'GPUs')}{renderSortIcon('gpu_requested')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[130px] cursor-pointer" onClick={() => handleSort('status')}>
                <span className="inline-flex items-center gap-1">{tr('gpuPods.table.status', 'Status')}{renderSortIcon('status')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('age')}>
                <span className="inline-flex items-center gap-1">{tr('gpuPods.table.age', 'Age')}{renderSortIcon('age')}</span>
              </th>
              {metricsAvailable && (
                <>
                  <th className="text-left py-3 px-4 w-[140px]">
                    {tr('gpuPods.table.gpuUtil', 'GPU Util')}
                  </th>
                  <th className="text-left py-3 px-4 w-[140px]">
                    {tr('gpuPods.table.memUtil', 'Mem Util')}
                  </th>
                </>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {pagedPods.map((pod, idx) => {
              const podKey = `${pod.namespace}/${pod.name}`
              const podMetric = podMetricsMap.get(podKey)
              return (
              <tr
                    ref={idx === 0 ? firstRowRef : undefined}
                key={podKey}
                className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                onClick={() => openDetail({ kind: 'Pod', name: pod.name, namespace: pod.namespace })}
              >
                <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{pod.namespace}</span></td>
                <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{pod.name}</span></td>
                <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{pod.node_name ?? '-'}</span></td>
                <td className="py-3 px-4 text-xs font-mono">{pod.gpu_requested}</td>
                <td className="py-3 px-4">
                  <span className={`badge ${getStatusColor(pod.status)}`}>{pod.status}</span>
                </td>
                <td className="py-3 px-4 text-xs font-mono">{formatAge(pod.created_at)}</td>
                {metricsAvailable && (
                  <>
                    <td className="py-3 px-4">
                      {podMetric ? (
                        <div className="flex items-center gap-2">
                          <div className="w-16 h-2 bg-slate-800 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${podMetric.gpu_util >= 80 ? 'bg-red-500' : podMetric.gpu_util >= 50 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                              style={{ width: `${Math.min(podMetric.gpu_util, 100)}%` }}
                            />
                          </div>
                          <span className="text-xs font-mono">{Math.round(podMetric.gpu_util)}%</span>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-500">-</span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      {podMetric ? (
                        <div className="flex items-center gap-2">
                          <div className="w-16 h-2 bg-slate-800 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${podMetric.memory_util_percent >= 80 ? 'bg-red-500' : podMetric.memory_util_percent >= 50 ? 'bg-amber-500' : 'bg-blue-500'}`}
                              style={{ width: `${Math.min(podMetric.memory_util_percent, 100)}%` }}
                            />
                          </div>
                          <span className="text-xs font-mono">{Math.round(podMetric.memory_util_percent)}%</span>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-500">-</span>
                      )}
                    </td>
                  </>
                )}
              </tr>
              )
            })}
            {isLoading && (
              <tr>
                <td colSpan={metricsAvailable ? 8 : 6} className="py-10 px-4 text-center text-slate-400">
                  <div className="inline-flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading...
                  </div>
                </td>
              </tr>
            )}
            {sortedPodsLength === 0 && !isLoading && (
              <tr>
                <td colSpan={metricsAvailable ? 8 : 6} className="py-6 px-4 text-center text-slate-400">
                  {tr('gpuPods.noResults', 'No GPU pods found.')}
                </td>
              </tr>
            )}
          </tbody>
            <AdaptiveTableFillerRows count={rowsPerPage - pagedPods.length} columnCount={8} />
        </table>
      </div>
      {sortedPodsLength > 0 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
          <div className="text-xs text-slate-400">
            {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
              start: (currentPage - 1) * rowsPerPage + 1,
              end: Math.min(currentPage * rowsPerPage, sortedPodsLength),
              total: sortedPodsLength,
            })}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
              disabled={currentPage <= 1}
              className="px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:text-white hover:border-slate-500"
            >
              {tr('common.prev', 'Prev')}
            </button>
            <span className="text-xs text-slate-300 min-w-[72px] text-center">
              {currentPage} / {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))}
              disabled={currentPage >= totalPages}
              className="px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:text-white hover:border-slate-500"
            >
              {tr('common.next', 'Next')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
