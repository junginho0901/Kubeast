// GatewayClasses 목록 테이블 + sort 헤더 + pagination
//
// frontend/src/pages/gateway/GatewayClasses.tsx 의 table JSX (sort header +
// tbody + 빈/로딩 상태 + pagination footer) 추출. cluster-scoped 라 namespace
// 컬럼 없음. 5 컬럼 모두 sortable (name/controller/status/parameters/age).
// min-w-[940px].

import type { Dispatch, RefObject, SetStateAction } from 'react'
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import type { GatewayClassInfo } from '@/services/api'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import {
  formatAge,
  formatParametersRef,
  gatewayClassToRawJson,
  type SortKey,
} from './gatewayClassHelpers'

interface OpenDetailArgs {
  kind: string
  name: string
  rawJson?: Record<string, unknown>
}

interface Props {
  pagedGatewayClasses: GatewayClassInfo[]
  sortedGatewayClassesLength: number
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

export function GatewayClassTable({
  pagedGatewayClasses,
  sortedGatewayClassesLength,
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
        <table className="w-full text-sm min-w-[940px] table-fixed">
          <thead ref={theadRef} className="text-slate-400">
            <tr>
              <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('name')}>
                <span className="inline-flex items-center gap-1">{tr('gatewayClassesPage.table.name', 'Name')}{renderSortIcon('name')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[270px] cursor-pointer" onClick={() => handleSort('controller')}>
                <span className="inline-flex items-center gap-1">{tr('gatewayClassesPage.table.controller', 'Controller')}{renderSortIcon('controller')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[170px] cursor-pointer" onClick={() => handleSort('status')}>
                <span className="inline-flex items-center gap-1">{tr('gatewayClassesPage.table.conditions', 'Conditions')}{renderSortIcon('status')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[200px] cursor-pointer" onClick={() => handleSort('parameters')}>
                <span className="inline-flex items-center gap-1">{tr('gatewayClassesPage.table.parametersRef', 'Parameters Ref')}{renderSortIcon('parameters')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                <span className="inline-flex items-center gap-1">{tr('gatewayClassesPage.table.age', 'Age')}{renderSortIcon('age')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {pagedGatewayClasses.map((item, idx) => (
              <tr
                    ref={idx === 0 ? firstRowRef : undefined}
                key={item.name}
                className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                onClick={() => openDetail({
                  kind: 'GatewayClass',
                  name: item.name,
                  rawJson: gatewayClassToRawJson(item),
                })}
              >
                <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{item.name}</span></td>
                <td className="py-3 px-4 text-xs"><span className="block truncate">{item.controller_name || '-'}</span></td>
                <td className="py-3 px-4 text-xs"><span className="block truncate">{item.status || '-'}</span></td>
                <td className="py-3 px-4 text-xs"><span className="block truncate">{formatParametersRef(item)}</span></td>
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

            {sortedGatewayClassesLength === 0 && !isLoading && (
              <tr>
                <td colSpan={5} className="py-6 px-4 text-center text-slate-400">
                  {tr('gatewayClassesPage.noResults', 'No gateway classes found.')}
                </td>
              </tr>
            )}
          </tbody>
            <AdaptiveTableFillerRows count={rowsPerPage - pagedGatewayClasses.length} columnCount={5} />
        </table>
      </div>

      {sortedGatewayClassesLength > 0 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
          <div className="text-xs text-slate-400">
            {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
              start: (currentPage - 1) * rowsPerPage + 1,
              end: Math.min(currentPage * rowsPerPage, sortedGatewayClassesLength),
              total: sortedGatewayClassesLength,
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
