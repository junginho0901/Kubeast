// IngressClasses 목록 테이블 + sort 헤더 + pagination
//
// frontend/src/pages/network/IngressClasses.tsx 의 table JSX (sort header +
// tbody + 빈/로딩 상태 + pagination footer) 추출. cluster-scoped 라 namespace
// 컬럼 없음. 5 컬럼 모두 sortable (name/controller/default/parameters/age).
// pagination 은 totalPages > 1 + common.pagination.range 키 사용 (다른 페이지의
// common.paginationRange 와 다름 — IngressClasses 원본 그대로 보존).

import type { Dispatch, RefObject, SetStateAction } from 'react'
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import type { IngressClassInfo } from '@/services/api'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import {
  formatAge,
  formatParameters,
  ingressClassToRawJson,
  type SortKey,
} from './ingressClassHelpers'

interface OpenDetailArgs {
  kind: string
  name: string
  rawJson?: Record<string, unknown>
}

interface Props {
  pagedIngressClasses: IngressClassInfo[]
  sortedIngressClassesLength: number
  isLoading: boolean
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

export function IngressClassTable({
  pagedIngressClasses,
  sortedIngressClassesLength,
  isLoading,
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
        <table className="w-full text-sm min-w-[1060px] table-fixed">
          <thead ref={theadRef} className="text-slate-400">
            <tr>
              <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('name')}>
                <span className="inline-flex items-center gap-1">{tr('ingressClassesPage.table.name', 'Name')}{renderSortIcon('name')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[260px] cursor-pointer" onClick={() => handleSort('controller')}>
                <span className="inline-flex items-center gap-1">{tr('ingressClassesPage.table.controller', 'Controller')}{renderSortIcon('controller')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[110px] cursor-pointer" onClick={() => handleSort('default')}>
                <span className="inline-flex items-center gap-1">{tr('ingressClassesPage.table.default', 'Default')}{renderSortIcon('default')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[310px] cursor-pointer" onClick={() => handleSort('parameters')}>
                <span className="inline-flex items-center gap-1">{tr('ingressClassesPage.table.parameters', 'Parameters')}{renderSortIcon('parameters')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                <span className="inline-flex items-center gap-1">{tr('ingressClassesPage.table.age', 'Age')}{renderSortIcon('age')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {pagedIngressClasses.map((item, idx) => (
              <tr
                    ref={idx === 0 ? firstRowRef : undefined}
                key={item.name}
                className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                onClick={() => openDetail({
                  kind: 'IngressClass',
                  name: item.name,
                  rawJson: ingressClassToRawJson(item),
                })}
              >
                <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{item.name}</span></td>
                <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{item.controller || '-'}</span></td>
                <td className="py-3 px-4 text-xs">
                  {item.is_default
                    ? <span className="badge badge-success">{tr('common.yes', 'Yes')}</span>
                    : <span className="badge badge-info">{tr('common.no', 'No')}</span>}
                </td>
                <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{formatParameters(item)}</span></td>
                <td className="py-3 px-4 text-xs font-mono">{formatAge(item.created_at)}</td>
              </tr>
            ))}
            {isLoading && (
              <tr>
                <td colSpan={5} className="py-10 px-4 text-center text-slate-400">
                  <div className="inline-flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading...
                  </div>
                </td>
              </tr>
            )}

            {sortedIngressClassesLength === 0 && !isLoading && (
              <tr>
                <td colSpan={5} className="py-6 px-4 text-center text-slate-400">
                  {tr('ingressClassesPage.noResults', 'No ingress classes found.')}
                </td>
              </tr>
            )}
          </tbody>
            <AdaptiveTableFillerRows count={rowsPerPage - pagedIngressClasses.length} columnCount={5} />
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-slate-400 px-4 py-3 border-t border-slate-700 shrink-0">
          <span>
            {(() => {
              const total = sortedIngressClassesLength
              if (total === 0) return tr('common.pagination.empty', '0')
              const from = (currentPage - 1) * rowsPerPage + 1
              const to = Math.min(currentPage * rowsPerPage, total)
              return tr('common.pagination.range', '{{from}}-{{to}} / {{total}}', { from, to, total })
            })()}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn btn-secondary px-2 py-1 disabled:opacity-50"
              disabled={currentPage === 1}
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            >
              {tr('common.pagination.prev', 'Prev')}
            </button>
            <span>{currentPage} / {totalPages}</span>
            <button
              type="button"
              className="btn btn-secondary px-2 py-1 disabled:opacity-50"
              disabled={currentPage === totalPages}
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            >
              {tr('common.pagination.next', 'Next')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
