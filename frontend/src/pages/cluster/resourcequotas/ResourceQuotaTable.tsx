// ResourceQuotas 테이블 — sort header (4 컬럼) / tbody / pagination.
//
// ResourceQuotas.tsx 본체에서 분리. requests 컬럼 = status_hard key 개수.

import type { ResourceQuotaInfo } from '@/services/api'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { formatAge, type SortKey } from './resourceQuotaHelpers'

interface ResourceQuotaTableProps {
  pagedResourceQuotas: ResourceQuotaInfo[]
  sortedResourceQuotasLength: number
  isLoading: boolean
  showNamespaceColumn: boolean
  sortKey: SortKey
  sortDir: 'asc' | 'desc'
  onSort: (key: NonNullable<SortKey>) => void
  currentPage: number
  totalPages: number
  rowsPerPage: number
  onPageChange: (page: number) => void
  onOpenDetail: (item: ResourceQuotaInfo) => void
  containerRef: React.RefObject<HTMLDivElement>
  bodyRef: React.RefObject<HTMLDivElement>
  theadRef: React.RefObject<HTMLTableSectionElement>
  firstRowRef: React.RefObject<HTMLTableRowElement>
}

export function ResourceQuotaTable({
  pagedResourceQuotas,
  sortedResourceQuotasLength,
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
}: ResourceQuotaTableProps) {
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
                  {tr('resourceQuotas.table.name', 'Name')}{renderSortIcon('name')}
                </span>
              </th>
              {showNamespaceColumn && (
                <th className="text-left py-3 px-4 w-[150px] cursor-pointer" onClick={() => onSort('namespace')}>
                  <span className="inline-flex items-center gap-1">
                    {tr('resourceQuotas.table.namespace', 'Namespace')}{renderSortIcon('namespace')}
                  </span>
                </th>
              )}
              <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => onSort('requests')}>
                <span className="inline-flex items-center gap-1">
                  {tr('resourceQuotas.table.requests', 'Request')}{renderSortIcon('requests')}
                </span>
              </th>
              <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => onSort('age')}>
                <span className="inline-flex items-center gap-1">
                  {tr('resourceQuotas.table.age', 'Age')}{renderSortIcon('age')}
                </span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {pagedResourceQuotas.map((rq, idx) => (
              <tr
                ref={idx === 0 ? firstRowRef : undefined}
                key={`${rq.namespace}/${rq.name}`}
                className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                onClick={() => onOpenDetail(rq)}
              >
                <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{rq.name}</span></td>
                {showNamespaceColumn && (
                  <td className="py-3 px-4 text-xs font-mono text-slate-400">{rq.namespace}</td>
                )}
                <td className="py-3 px-4 text-xs font-mono">{Object.keys(rq.status_hard || {}).length}</td>
                <td className="py-3 px-4 text-xs font-mono">{formatAge(rq.created_at)}</td>
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

            {sortedResourceQuotasLength === 0 && !isLoading && (
              <tr>
                <td colSpan={showNamespaceColumn ? 4 : 3} className="py-6 px-4 text-center text-slate-400">
                  {tr('resourceQuotas.noResults', 'No resource quotas found.')}
                </td>
              </tr>
            )}
          </tbody>
          <AdaptiveTableFillerRows count={rowsPerPage - pagedResourceQuotas.length} columnCount={3 + (showNamespaceColumn ? 1 : 0)} />
        </table>
      </div>
      {sortedResourceQuotasLength > 0 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
          <div className="text-xs text-slate-400">
            {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
              start: (currentPage - 1) * rowsPerPage + 1,
              end: Math.min(currentPage * rowsPerPage, sortedResourceQuotasLength),
              total: sortedResourceQuotasLength,
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
