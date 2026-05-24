import { RefObject } from 'react'
import { Loader2, ChevronDown, ChevronUp } from 'lucide-react'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { formatRelative, getStatusColor } from './namespaceHelpers'
import type { NamespaceInfo, SortKey, SortDir } from './namespaceHelpers'

interface Props {
  pagedNamespaces: NamespaceInfo[]
  sortedNamespacesCount: number
  isLoadingNs: boolean
  searchQuery: string
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

export default function NamespaceTable({
  pagedNamespaces,
  sortedNamespacesCount,
  isLoadingNs,
  searchQuery,
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
        <table className="w-full text-sm min-w-[700px] table-fixed">
          <thead ref={theadRef} className="text-slate-400">
            <tr>
              <th className="text-left py-3 px-4 w-[40%] cursor-pointer" onClick={() => onSort('name')}>
                <span className="inline-flex items-center gap-1">
                  {tr('namespaces.table.name', 'Name')}{renderSortIcon('name')}
                </span>
              </th>
              <th className="text-left py-3 px-4 w-[15%] cursor-pointer" onClick={() => onSort('status')}>
                <span className="inline-flex items-center gap-1">
                  {tr('namespaces.table.status', 'Status')}{renderSortIcon('status')}
                </span>
              </th>
              <th className="text-left py-3 px-4 w-[30%]">
                {tr('namespaces.table.labels', 'Labels')}
              </th>
              <th className="text-left py-3 px-4 w-[15%] cursor-pointer" onClick={() => onSort('age')}>
                <span className="inline-flex items-center gap-1">
                  {tr('namespaces.table.age', 'Age')}{renderSortIcon('age')}
                </span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {pagedNamespaces.map((ns, idx) => {
              const labelEntries = ns.labels ? Object.entries(ns.labels) : []
              return (
                <tr
                  ref={idx === 0 ? firstRowRef : undefined}
                  key={ns.name}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => onRowClick(ns.name)}
                >
                  <td className="py-3 px-4 font-medium text-white">
                    <span className="block truncate">{ns.name}</span>
                  </td>
                  <td className="py-3 px-4">
                    <span className={`badge ${getStatusColor(ns.status)}`}>{ns.status}</span>
                  </td>
                  <td className="py-3 px-4 text-xs">
                    <div className="flex flex-nowrap items-center gap-1 max-w-full overflow-hidden min-w-0 whitespace-nowrap">
                      {labelEntries.length > 0
                        ? labelEntries.slice(0, 2).map(([k, v]) => (
                            <span
                              key={k}
                              className="inline-block rounded-full border border-slate-700 bg-slate-800/80 px-2 py-0.5 text-slate-300 truncate max-w-[160px]"
                              title={`${k}: ${v}`}
                            >
                              {k}
                            </span>
                          ))
                        : <span className="text-slate-500">-</span>}
                      {labelEntries.length > 2 && (
                        <span className="text-slate-500 shrink-0">+{labelEntries.length - 2}</span>
                      )}
                    </div>
                  </td>
                  <td className="py-3 px-4 text-xs font-mono">
                    <span className="block truncate">{formatRelative(ns.created_at)}</span>
                  </td>
                </tr>
              )
            })}
            {isLoadingNs && (
              <tr>
                <td colSpan={4} className="py-10 px-4 text-center text-slate-400">
                  <div className="inline-flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading...
                  </div>
                </td>
              </tr>
            )}

            {sortedNamespacesCount === 0 && !isLoadingNs && (
              <tr>
                <td colSpan={4} className="py-6 px-4 text-center text-slate-400">
                  {searchQuery
                    ? tr('namespaces.noSearchResults', 'No results found')
                    : tr('namespaces.empty', 'No namespaces found')}
                </td>
              </tr>
            )}
          </tbody>
          <AdaptiveTableFillerRows count={rowsPerPage - pagedNamespaces.length} columnCount={4} />
        </table>
      </div>
      {sortedNamespacesCount > 0 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
          <div className="text-xs text-slate-400">
            {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
              start: (currentPage - 1) * rowsPerPage + 1,
              end: Math.min(currentPage * rowsPerPage, sortedNamespacesCount),
              total: sortedNamespacesCount,
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
