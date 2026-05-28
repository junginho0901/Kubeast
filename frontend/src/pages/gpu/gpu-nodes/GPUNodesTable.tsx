import { useTranslation } from 'react-i18next'
import { Loader2, ChevronUp, ChevronDown } from 'lucide-react'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import type { GPUNodeInfo } from '@/services/api'
import { getStatusColor, type SortKey } from './gpuNodesHelpers'

interface Props {
  sortedNodes: GPUNodeInfo[]
  pagedNodes: GPUNodeInfo[]
  isLoading: boolean
  sortKey: SortKey
  sortDir: 'asc' | 'desc'
  onSort: (key: NonNullable<SortKey>) => void
  currentPage: number
  totalPages: number
  rowsPerPage: number
  setCurrentPage: (updater: (prev: number) => number) => void
  tableContainerRef: React.RefObject<HTMLDivElement>
  tableBodyRef: React.RefObject<HTMLDivElement>
  theadRef: React.RefObject<HTMLTableSectionElement>
  firstRowRef: React.RefObject<HTMLTableRowElement>
  showCharts: boolean
}

export default function GPUNodesTable({
  sortedNodes,
  pagedNodes,
  isLoading,
  sortKey,
  sortDir,
  onSort,
  currentPage,
  totalPages,
  rowsPerPage,
  setCurrentPage,
  tableContainerRef,
  tableBodyRef,
  theadRef,
  firstRowRef,
  showCharts,
}: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const { open: openDetail } = useResourceDetail()

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
              <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => onSort('name')}>
                <span className="inline-flex items-center gap-1">{tr('gpuNodes.table.name', 'Name')}{renderSortIcon('name')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[200px] cursor-pointer" onClick={() => onSort('gpu_model')}>
                <span className="inline-flex items-center gap-1">{tr('gpuNodes.table.gpuModel', 'GPU Model')}{renderSortIcon('gpu_model')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => onSort('gpu_memory')}>
                <span className="inline-flex items-center gap-1">{tr('gpuNodes.table.gpuMemory', 'GPU Memory')}{renderSortIcon('gpu_memory')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[110px] cursor-pointer" onClick={() => onSort('gpu_capacity')}>
                <span className="inline-flex items-center gap-1">{tr('gpuNodes.table.capacity', 'Capacity')}{renderSortIcon('gpu_capacity')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => onSort('gpu_allocatable')}>
                <span className="inline-flex items-center gap-1">{tr('gpuNodes.table.allocatable', 'Allocatable')}{renderSortIcon('gpu_allocatable')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[110px] cursor-pointer" onClick={() => onSort('status')}>
                <span className="inline-flex items-center gap-1">{tr('gpuNodes.table.status', 'Status')}{renderSortIcon('status')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[130px] cursor-pointer" onClick={() => onSort('mig_strategy')}>
                <span className="inline-flex items-center gap-1">{tr('gpuNodes.table.migStrategy', 'MIG Strategy')}{renderSortIcon('mig_strategy')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {pagedNodes.map((node, idx) => (
              <tr
                ref={idx === 0 ? firstRowRef : undefined}
                key={node.name}
                className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                onClick={() => openDetail({ kind: 'Node', name: node.name })}
              >
                <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{node.name}</span></td>
                <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{node.gpu_model ?? '-'}</span></td>
                <td className="py-3 px-4 text-xs font-mono">{node.gpu_memory ?? '-'}</td>
                <td className="py-3 px-4 text-xs font-mono">{node.gpu_capacity}</td>
                <td className="py-3 px-4 text-xs font-mono">{node.gpu_allocatable}</td>
                <td className="py-3 px-4">
                  <span className={`badge ${getStatusColor(node.status)}`}>{node.status}</span>
                </td>
                <td className="py-3 px-4 text-xs font-mono">{node.mig_strategy ?? '-'}</td>
              </tr>
            ))}
            {isLoading && (
              <tr>
                <td colSpan={7} className="py-10 px-4 text-center text-slate-400">
                  <div className="inline-flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading...
                  </div>
                </td>
              </tr>
            )}
            {sortedNodes.length === 0 && !isLoading && (
              <tr>
                <td colSpan={7} className="py-6 px-4 text-center text-slate-400">
                  {tr('gpuNodes.noResults', 'No GPU nodes found.')}
                </td>
              </tr>
            )}
          </tbody>
          <AdaptiveTableFillerRows count={rowsPerPage - pagedNodes.length} columnCount={7} />
        </table>
      </div>
      {sortedNodes.length > 0 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
          <div className="text-xs text-slate-400">
            {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
              start: (currentPage - 1) * rowsPerPage + 1,
              end: Math.min(currentPage * rowsPerPage, sortedNodes.length),
              total: sortedNodes.length,
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
