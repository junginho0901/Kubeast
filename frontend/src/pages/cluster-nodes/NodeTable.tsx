import { RefObject } from 'react'
import { Loader2, ChevronDown, ChevronUp } from 'lucide-react'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { formatAge, getStatusColor } from './clusterNodeHelpers'
import type { NodeInfo, NodeMetric, SortKey, SortDir } from './clusterNodeHelpers'

interface Props {
  pagedNodes: NodeInfo[]
  sortedNodesCount: number
  metricsMap: Map<string, NodeMetric>
  isLoadingNodes: boolean
  sortKey: SortKey
  sortDir: SortDir
  onSort: (key: NonNullable<SortKey>) => void
  currentPage: number
  totalPages: number
  rowsPerPage: number
  onPageChange: (page: number) => void
  tableContainerRef: RefObject<HTMLDivElement>
  tableBodyRef: RefObject<HTMLDivElement>
  theadRef: RefObject<HTMLTableSectionElement>
  firstRowRef: RefObject<HTMLTableRowElement>
  onRowClick: (name: string) => void
  tr: (key: string, fallback: string, options?: Record<string, any>) => string
}

export default function NodeTable({
  pagedNodes,
  sortedNodesCount,
  metricsMap,
  isLoadingNodes,
  sortKey,
  sortDir,
  onSort,
  currentPage,
  totalPages,
  rowsPerPage,
  onPageChange,
  tableContainerRef,
  tableBodyRef,
  theadRef,
  firstRowRef,
  onRowClick,
  tr,
}: Props) {
  const renderSortIcon = (key: NonNullable<SortKey>) => {
    if (sortKey !== key) return null
    return sortDir === 'asc' ? (
      <ChevronUp className="w-3.5 h-3.5 text-slate-300" />
    ) : (
      <ChevronDown className="w-3.5 h-3.5 text-slate-300" />
    )
  }

  return (
    <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
      <div ref={tableBodyRef} className="overflow-x-auto flex-1 min-h-0">
        <table className="w-full text-sm min-w-[980px] table-fixed">
          <thead ref={theadRef} className="text-slate-400">
            <tr>
              <th className="text-left py-3 px-4 w-[260px] cursor-pointer" onClick={() => onSort('name')}>
                <span className="inline-flex items-center gap-1">{tr('nodes.table.name', 'Name')}{renderSortIcon('name')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => onSort('status')}>
                <span className="inline-flex items-center gap-1">{tr('nodes.table.status', 'Status')}{renderSortIcon('status')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[180px] cursor-pointer" onClick={() => onSort('roles')}>
                <span className="inline-flex items-center gap-1">{tr('nodes.table.roles', 'Roles')}{renderSortIcon('roles')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[150px] cursor-pointer" onClick={() => onSort('cpu')}>
                <span className="inline-flex items-center gap-1">{tr('nodes.table.cpu', 'CPU')}{renderSortIcon('cpu')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[170px] cursor-pointer" onClick={() => onSort('memory')}>
                <span className="inline-flex items-center gap-1">{tr('nodes.table.memory', 'Memory')}{renderSortIcon('memory')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[160px] cursor-pointer" onClick={() => onSort('version')}>
                <span className="inline-flex items-center gap-1">{tr('nodes.table.version', 'Version')}{renderSortIcon('version')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[150px] cursor-pointer" onClick={() => onSort('internal_ip')}>
                <span className="inline-flex items-center gap-1">{tr('nodes.table.internalIp', 'Internal IP')}{renderSortIcon('internal_ip')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[150px] cursor-pointer" onClick={() => onSort('external_ip')}>
                <span className="inline-flex items-center gap-1">{tr('nodes.table.externalIp', 'External IP')}{renderSortIcon('external_ip')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[110px] cursor-pointer" onClick={() => onSort('age')}>
                <span className="inline-flex items-center gap-1">{tr('nodes.table.age', 'Age')}{renderSortIcon('age')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {pagedNodes.map((node, idx) => {
              const metric = metricsMap.get(node.name)
              return (
                <tr
                  ref={idx === 0 ? firstRowRef : undefined}
                  key={node.name}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => onRowClick(node.name)}
                >
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{node.name}</span></td>
                  <td className="py-3 px-4">
                    <div className="flex flex-wrap gap-1">
                      {node.status.split(',').map((s: string, i: number) => (
                        <span key={i} className={`badge ${getStatusColor(s.trim())}`}>{s.trim()}</span>
                      ))}
                    </div>
                  </td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{node.roles && node.roles.length > 0 ? node.roles.join(', ') : '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{metric ? `${metric.cpu} (${metric.cpu_percent})` : '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{metric ? `${metric.memory} (${metric.memory_percent})` : '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{node.version || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{node.internal_ip || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{node.external_ip || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{formatAge(node.age)}</span></td>
                </tr>
              )
            })}
            {isLoadingNodes && (
              <tr>
                <td colSpan={9} className="py-10 px-4 text-center text-slate-400">
                  <div className="inline-flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading...
                  </div>
                </td>
              </tr>
            )}

            {sortedNodesCount === 0 && !isLoadingNodes && (
              <tr>
                <td colSpan={9} className="py-6 px-4 text-center text-slate-400">
                  {tr('nodes.noResults', 'No nodes found.')}
                </td>
              </tr>
            )}
          </tbody>
          <AdaptiveTableFillerRows count={rowsPerPage - pagedNodes.length} columnCount={9} />
        </table>
      </div>
      {sortedNodesCount > 0 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
          <div className="text-xs text-slate-400">
            {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
              start: (currentPage - 1) * rowsPerPage + 1,
              end: Math.min(currentPage * rowsPerPage, sortedNodesCount),
              total: sortedNodesCount,
            })}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onPageChange(Math.max(1, currentPage - 1))}
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
              onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
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
