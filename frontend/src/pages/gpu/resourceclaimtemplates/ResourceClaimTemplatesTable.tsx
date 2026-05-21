// ResourceClaimTemplates 목록 테이블 + sort 헤더 + pagination
//
// frontend/src/pages/gpu/ResourceClaimTemplates.tsx 의 table JSX (sort
// header + tbody + 빈/로딩 상태 + pagination footer) 추출. useAdaptiveTable
// 의 ref/rowsPerPage 는 부모에서 hook 호출 후 props 로 전달.
// 4 컬럼 (namespace + name + requests + age) 모두 sortable. min-w-[800px].
// Template 은 status/badge 없음 — ResourceClaimsTable 보다 1 컬럼 적음.

import type { Dispatch, RefObject, SetStateAction } from 'react'
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import type { ResourceClaimTemplateItem } from '@/services/api'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { formatAge, type SortKey } from './resourceClaimTemplatesHelpers'

interface OpenDetailArgs {
  kind: string
  name: string
  namespace: string
}

interface Props {
  pagedResourceClaimTemplates: ResourceClaimTemplateItem[]
  sortedResourceClaimTemplatesLength: number
  isLoading: boolean
  showNamespaceColumn: boolean
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

export function ResourceClaimTemplatesTable({
  pagedResourceClaimTemplates,
  sortedResourceClaimTemplatesLength,
  isLoading,
  showNamespaceColumn,
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
    return sortDir === 'asc'
      ? <ChevronUp className="w-3.5 h-3.5 text-slate-300" />
      : <ChevronDown className="w-3.5 h-3.5 text-slate-300" />
  }

  return (
    <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
      <div ref={tableBodyRef} className="overflow-x-auto flex-1 min-h-0">
        <table className="w-full text-sm min-w-[800px] table-fixed">
          <thead ref={theadRef} className="text-slate-400">
            <tr>
              {showNamespaceColumn && (
                <th className="text-left py-3 px-4 w-[200px] cursor-pointer" onClick={() => handleSort('namespace')}>
                  <span className="inline-flex items-center gap-1">{tr('resourceClaimTemplatesPage.table.namespace', 'Namespace')}{renderSortIcon('namespace')}</span>
                </th>
              )}
              <th className="text-left py-3 px-4 w-[280px] cursor-pointer" onClick={() => handleSort('name')}>
                <span className="inline-flex items-center gap-1">{tr('resourceClaimTemplatesPage.table.name', 'Name')}{renderSortIcon('name')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('requests')}>
                <span className="inline-flex items-center gap-1">{tr('resourceClaimTemplatesPage.table.requests', 'Requests')}{renderSortIcon('requests')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('age')}>
                <span className="inline-flex items-center gap-1">{tr('resourceClaimTemplatesPage.table.age', 'Age')}{renderSortIcon('age')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {pagedResourceClaimTemplates.map((item, idx) => (
              <tr
                    ref={idx === 0 ? firstRowRef : undefined}
                key={`${item.namespace}/${item.name}`}
                className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                onClick={() => openDetail({
                  kind: 'ResourceClaimTemplate',
                  name: item.name,
                  namespace: item.namespace,
                })}
              >
                {showNamespaceColumn && <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{item.namespace}</span></td>}
                <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{item.name}</span></td>
                <td className="py-3 px-4 text-xs font-mono">{item.request_count || 0}</td>
                <td className="py-3 px-4 text-xs font-mono">{formatAge(item.created_at)}</td>
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

            {sortedResourceClaimTemplatesLength === 0 && !isLoading && (
              <tr>
                <td colSpan={showNamespaceColumn ? 4 : 3} className="py-6 px-4 text-center text-slate-400">
                  {tr('resourceClaimTemplatesPage.noResults', 'No ResourceClaimTemplates found.')}
                </td>
              </tr>
            )}
          </tbody>
            <AdaptiveTableFillerRows count={rowsPerPage - pagedResourceClaimTemplates.length} columnCount={3 + (showNamespaceColumn ? 1 : 0)} />
        </table>
      </div>

      {sortedResourceClaimTemplatesLength > 0 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
          <div className="text-xs text-slate-400">
            {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
              start: (currentPage - 1) * rowsPerPage + 1,
              end: Math.min(currentPage * rowsPerPage, sortedResourceClaimTemplatesLength),
              total: sortedResourceClaimTemplatesLength,
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
            <span className="text-xs text-slate-300 min-w-[72px] text-center">{currentPage} / {totalPages}</span>
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
