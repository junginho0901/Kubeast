import { useTranslation, Trans } from 'react-i18next'
import { Loader2, ChevronUp, ChevronDown } from 'lucide-react'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { ListPager } from '@/components/ListPager'
import { TableEmptyRow } from '@/components/TableEmptyRow'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import type { GPUNodeInfo } from '@/services/api'
import { getStatusColor, type SortKey } from './gpuNodesHelpers'
import { nodeStatusParts } from '@/utils/nodeStatus'
import { vendorNames } from '../gpuNumbers'
import { openOnPress } from '@/components/openOnPress'
import { SortButton } from '@/components/SortButton'
import { sortHeaderProps } from '@/components/sortHeaderProps'

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
  searching?: boolean
  tableContainerRef: React.RefObject<HTMLDivElement | null>
  tableBodyRef: React.RefObject<HTMLDivElement | null>
  theadRef: React.RefObject<HTMLTableSectionElement | null>
  firstRowRef: React.RefObject<HTMLTableRowElement | null>
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
  searching,
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

  const sortHead = sortHeaderProps(sortKey, sortDir, onSort)
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
        <table className="w-full text-sm min-w-[1090px] table-fixed">
          <thead ref={theadRef} className="text-slate-400">
            <tr>
              <th className="text-left py-3 px-4 w-[220px] cursor-pointer" {...sortHead('name')}>
                <SortButton>{tr('gpuNodes.table.name', 'Name')}{renderSortIcon('name')}</SortButton>
              </th>
              <th className="text-left py-3 px-4 w-[110px] cursor-pointer" {...sortHead('gpu_vendor')}>
                <SortButton>{tr('gpuNodes.table.vendor', 'Vendor')}{renderSortIcon('gpu_vendor')}</SortButton>
              </th>
              <th className="text-left py-3 px-4 w-[200px] cursor-pointer" {...sortHead('gpu_model')}>
                <SortButton>{tr('gpuNodes.table.gpuModel', 'GPU Model')}{renderSortIcon('gpu_model')}</SortButton>
              </th>
              <th className="text-left py-3 px-4 w-[120px] cursor-pointer" {...sortHead('gpu_memory')}>
                <SortButton>{tr('gpuNodes.table.gpuMemory', 'GPU Memory')}{renderSortIcon('gpu_memory')}</SortButton>
              </th>
              <th className="text-left py-3 px-4 w-[110px] cursor-pointer" {...sortHead('gpu_capacity')}>
                <SortButton>{tr('gpuNodes.table.capacity', 'Capacity')}{renderSortIcon('gpu_capacity')}</SortButton>
              </th>
              <th className="text-left py-3 px-4 w-[120px] cursor-pointer" {...sortHead('gpu_allocatable')}>
                <SortButton>{tr('gpuNodes.table.allocatable', 'Allocatable')}{renderSortIcon('gpu_allocatable')}</SortButton>
              </th>
              <th className="text-left py-3 px-4 w-[110px] cursor-pointer" {...sortHead('status')}>
                <SortButton>{tr('gpuNodes.table.status', 'Status')}{renderSortIcon('status')}</SortButton>
              </th>
              <th className="col-optional text-left py-3 px-4 w-[130px] cursor-pointer" {...sortHead('mig_strategy')}>
                <SortButton>{tr('gpuNodes.table.migStrategy', 'MIG Strategy')}{renderSortIcon('mig_strategy')}</SortButton>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {pagedNodes.map((node, idx) => (
              <tr
                ref={idx === 0 ? firstRowRef : undefined}
                key={node.name}
                className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                {...openOnPress(() => openDetail({ kind: 'Node', name: node.name }))}
              >
                <td className="py-3 px-4 font-medium text-ink"><span className="block truncate">{node.name}</span></td>
                <td className="py-3 px-4 text-xs"><span className="block truncate">{vendorNames(node.gpu_vendors) || '-'}</span></td>
                <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{node.gpu_model ?? '-'}</span></td>
                <td className="py-3 px-4 text-xs font-mono">{node.gpu_memory ?? '-'}</td>
                <td className="py-3 px-4 text-xs font-mono">{node.gpu_capacity}</td>
                <td className="py-3 px-4 text-xs font-mono">{node.gpu_allocatable}</td>
                <td className="py-3 px-4">
                  <div className="flex flex-wrap gap-1">
                    {nodeStatusParts(node.status).map((part) => (
                      <span key={part} className={`badge ${getStatusColor(part)}`}>{part}</span>
                    ))}
                  </div>
                </td>
                <td className="col-optional py-3 px-4 text-xs font-mono">{node.mig_strategy ?? '-'}</td>
              </tr>
            ))}
            {isLoading && (
              <tr>
                <td colSpan={8} className="py-10 px-4 text-center text-slate-400">
                  <div className="inline-flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    
                    <Trans i18nKey="common.loading" />
                  </div>
                </td>
              </tr>
            )}
            {sortedNodes.length === 0 && !isLoading && (
              <TableEmptyRow colSpan={8} resource="gpu" searching={searching} />
            )}
          </tbody>
          <AdaptiveTableFillerRows count={rowsPerPage - pagedNodes.length} columnCount={8} />
        </table>
      </div>
      <ListPager currentPage={currentPage} totalPages={totalPages} total={sortedNodes.length} rowsPerPage={rowsPerPage} onPageChange={(p) => setCurrentPage(() => p)} />
    </div>
  )
}
