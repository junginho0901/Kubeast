// Gateways 목록 테이블 + sort 헤더 + pagination
//
// frontend/src/pages/gateway/Gateways.tsx 의 table JSX (sort header + tbody +
// 빈/로딩 상태 + pagination footer) 추출. useAdaptiveTable 의 ref/rowsPerPage
// 는 부모에서 hook 호출 후 props 로 전달.
// 8 컬럼 (namespace + name + class + status/Conditions + listeners + routes +
// addresses + age) 모두 sortable. min-w-[1120px].

import type { Dispatch, RefObject, SetStateAction } from 'react'
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import type { GatewayInfo } from '@/services/api'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import {
  formatAge,
  gatewayToRawJson,
  type SortKey,
} from './gatewayHelpers'

interface OpenDetailArgs {
  kind: string
  name: string
  namespace: string
  rawJson?: Record<string, unknown>
}

interface Props {
  pagedGateways: GatewayInfo[]
  sortedGatewaysLength: number
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

export function GatewayTable({
  pagedGateways,
  sortedGatewaysLength,
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
        <table className="w-full text-sm min-w-[1120px] table-fixed">
          <thead ref={theadRef} className="text-slate-400">
            <tr>
              {showNamespaceColumn && (
                <th className="text-left py-3 px-4 w-[170px] cursor-pointer" onClick={() => handleSort('namespace')}>
                  <span className="inline-flex items-center gap-1">{tr('gatewaysPage.table.namespace', 'Namespace')}{renderSortIcon('namespace')}</span>
                </th>
              )}
              <th className="text-left py-3 px-4 w-[250px] cursor-pointer" onClick={() => handleSort('name')}>
                <span className="inline-flex items-center gap-1">{tr('gatewaysPage.table.name', 'Name')}{renderSortIcon('name')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[170px] cursor-pointer" onClick={() => handleSort('class')}>
                <span className="inline-flex items-center gap-1">{tr('gatewaysPage.table.class', 'Class Name')}{renderSortIcon('class')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[160px] cursor-pointer" onClick={() => handleSort('status')}>
                <span className="inline-flex items-center gap-1">{tr('gatewaysPage.table.status', 'Conditions')}{renderSortIcon('status')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('listeners')}>
                <span className="inline-flex items-center gap-1">{tr('gatewaysPage.table.listeners', 'Listeners')}{renderSortIcon('listeners')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[140px] cursor-pointer" onClick={() => handleSort('routes')}>
                <span className="inline-flex items-center gap-1">{tr('gatewaysPage.table.attachedRoutes', 'Attached Routes')}{renderSortIcon('routes')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('addresses')}>
                <span className="inline-flex items-center gap-1">{tr('gatewaysPage.table.addresses', 'Addresses')}{renderSortIcon('addresses')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                <span className="inline-flex items-center gap-1">{tr('gatewaysPage.table.age', 'Age')}{renderSortIcon('age')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {pagedGateways.map((gateway, idx) => (
              <tr
                    ref={idx === 0 ? firstRowRef : undefined}
                key={`${gateway.namespace}/${gateway.name}`}
                className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                onClick={() => openDetail({
                  kind: 'Gateway',
                  name: gateway.name,
                  namespace: gateway.namespace,
                  rawJson: gatewayToRawJson(gateway),
                })}
              >
                {showNamespaceColumn && <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{gateway.namespace}</span></td>}
                <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{gateway.name}</span></td>
                <td className="py-3 px-4 text-xs"><span className="block truncate">{gateway.gateway_class_name || '-'}</span></td>
                <td className="py-3 px-4 text-xs"><span className="block truncate">{gateway.status || '-'}</span></td>
                <td className="py-3 px-4 text-xs font-mono">{gateway.listeners_count || 0}</td>
                <td className="py-3 px-4 text-xs font-mono">{gateway.attached_routes || 0}</td>
                <td className="py-3 px-4 text-xs font-mono">{gateway.addresses_count || 0}</td>
                <td className="py-3 px-4 text-xs font-mono">{formatAge(gateway.created_at)}</td>
              </tr>
            ))}
            {isLoading && (
              <tr>
                <td colSpan={showNamespaceColumn ? 9 : 8} className="py-10 px-4 text-center text-slate-400">
                  <div className="inline-flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading...
                  </div>
                </td>
              </tr>
            )}

            {sortedGatewaysLength === 0 && !isLoading && (
              <tr>
                <td colSpan={showNamespaceColumn ? 9 : 8} className="py-6 px-4 text-center text-slate-400">
                  {tr('gatewaysPage.noResults', 'No gateways found.')}
                </td>
              </tr>
            )}
          </tbody>
            <AdaptiveTableFillerRows count={rowsPerPage - pagedGateways.length} columnCount={7 + (showNamespaceColumn ? 1 : 0)} />
        </table>
      </div>

      {sortedGatewaysLength > 0 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
          <div className="text-xs text-slate-400">
            {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
              start: (currentPage - 1) * rowsPerPage + 1,
              end: Math.min(currentPage * rowsPerPage, sortedGatewaysLength),
              total: sortedGatewaysLength,
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
