// LimitRanges 테이블 — sort header / tbody / 빈·로딩 / pagination.
//
// LimitRanges.tsx 본체에서 분리. 부모는 데이터 + sort/page 상태 + sort
// handler 만 prop 으로 전달. useAdaptiveTable 의 ref/rowsPerPage 는
// 부모에서 hook 호출 후 props 로 받음.

import type { LimitRangeInfo } from '@/services/api'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import {
  getLimitTypes,
  formatAge,
  type SortKey,
} from './limitRangeHelpers'

interface LimitRangeTableProps {
  pagedLimitRanges: LimitRangeInfo[]
  sortedLimitRangesLength: number
  isLoading: boolean
  showNamespaceColumn: boolean
  sortKey: SortKey
  sortDir: 'asc' | 'desc'
  onSort: (key: NonNullable<SortKey>) => void
  currentPage: number
  totalPages: number
  rowsPerPage: number
  onPageChange: (page: number) => void
  onOpenDetail: (item: LimitRangeInfo) => void
  containerRef: React.RefObject<HTMLDivElement>
  bodyRef: React.RefObject<HTMLDivElement>
  theadRef: React.RefObject<HTMLTableSectionElement>
  firstRowRef: React.RefObject<HTMLTableRowElement>
}

export function LimitRangeTable({
  pagedLimitRanges,
  sortedLimitRangesLength,
  isLoading,
  showNamespaceColumn,
  sortKey,
  sortDir,
  onSort,
  currentPage,
  totalPages,
  rowsPerPage,
  onPageChange,
  onOpenDetail,
  containerRef,
  bodyRef,
  theadRef,
  firstRowRef,
}: LimitRangeTableProps) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })

  const renderSortIcon = (key: NonNullable<SortKey>) => {
    if (sortKey !== key) return null
    return sortDir === 'asc'
      ? <ChevronUp className="w-3.5 h-3.5 text-slate-300" />
      : <ChevronDown className="w-3.5 h-3.5 text-slate-300" />
  }

  return (
    <div ref={containerRef} className="card flex-1 min-h-0 flex flex-col">
      <div ref={bodyRef} className="overflow-x-auto flex-1 min-h-0">
        <table className="w-full text-sm min-w-[700px] table-fixed">
          <thead ref={theadRef} className="text-slate-400">
            <tr>
              <th className="text-left py-3 px-4 w-[250px] cursor-pointer" onClick={() => onSort('name')}>
                <span className="inline-flex items-center gap-1">
                  {tr('limitRanges.table.name', 'Name')}{renderSortIcon('name')}
                </span>
              </th>
              {showNamespaceColumn && (
                <th className="text-left py-3 px-4 w-[150px] cursor-pointer" onClick={() => onSort('namespace')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('limitRanges.table.namespace', 'Namespace')}{renderSortIcon('namespace')}
                  </span>
                </th>
              )}
              <th className="text-left py-3 px-4 w-[200px] cursor-pointer" onClick={() => onSort('types')}>
                <span className="inline-flex items-center gap-1">
                  {tr('limitRanges.table.types', 'Types')}{renderSortIcon('types')}
                </span>
              </th>
              <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => onSort('age')}>
                <span className="inline-flex items-center gap-1">
                  {tr('limitRanges.table.age', 'Age')}{renderSortIcon('age')}
                </span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {pagedLimitRanges.map((lr, idx) => (
              <tr
                ref={idx === 0 ? firstRowRef : undefined}
                key={`${lr.namespace}/${lr.name}`}
                className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                onClick={() => onOpenDetail(lr)}
              >
                <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{lr.name}</span></td>
                {showNamespaceColumn && (
                  <td className="py-3 px-4 text-xs font-mono text-slate-400">{lr.namespace}</td>
                )}
                <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{getLimitTypes(lr)}</span></td>
                <td className="py-3 px-4 text-xs font-mono">{formatAge(lr.created_at)}</td>
              </tr>
            ))}
            {isLoading && (
              <tr>
                <td colSpan={showNamespaceColumn ? 4 : 3} className="py-10 px-4 text-center text-slate-400">
                  <div className="inline-flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading...
                  </div>
                </td>
              </tr>
            )}

            {sortedLimitRangesLength === 0 && !isLoading && (
              <tr>
                <td colSpan={showNamespaceColumn ? 4 : 3} className="py-6 px-4 text-center text-slate-400">
                  {tr('limitRanges.noResults', 'No limit ranges found.')}
                </td>
              </tr>
            )}
          </tbody>
          <AdaptiveTableFillerRows count={rowsPerPage - pagedLimitRanges.length} columnCount={3 + (showNamespaceColumn ? 1 : 0)} />
        </table>
      </div>
      {sortedLimitRangesLength > 0 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
          <div className="text-xs text-slate-400">
            {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
              start: (currentPage - 1) * rowsPerPage + 1,
              end: Math.min(currentPage * rowsPerPage, sortedLimitRangesLength),
              total: sortedLimitRangesLength,
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
