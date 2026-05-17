// EndpointSlice 목록 테이블 + sort 헤더 + pagination
//
// frontend/src/pages/network/EndpointSlices.tsx 의 table JSX (sort header +
// tbody + 빈/로딩 상태 + pagination footer) 추출. useAdaptiveTable 의
// ref/rowsPerPage 는 부모에서 hook 호출 후 props 로 전달.
// Endpoints preview 컬럼만 정렬 X (다른 9 컬럼은 sortable).

import type { Dispatch, RefObject, SetStateAction } from 'react'
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import type { EndpointSliceInfo } from '@/services/api'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import {
  endpointSliceToRawJson,
  formatAge,
  formatEndpointPreview,
  formatPorts,
  resolveNotReadyCount,
  type SortKey,
} from './endpointSliceHelpers'

interface OpenDetailArgs {
  kind: string
  name: string
  namespace: string
  rawJson?: Record<string, unknown>
}

interface Props {
  pagedEndpointSlices: EndpointSliceInfo[]
  sortedEndpointSlicesLength: number
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

export function EndpointSliceTable({
  pagedEndpointSlices,
  sortedEndpointSlicesLength,
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
        <table className="w-full text-sm min-w-[1320px] table-fixed">
          <thead ref={theadRef} className="text-slate-400">
            <tr>
              {showNamespaceColumn && (
                <th className="text-left py-3 px-4 w-[160px] cursor-pointer" onClick={() => handleSort('namespace')}>
                  <span className="inline-flex items-center gap-1">{tr('endpointSlicesPage.table.namespace', 'Namespace')}{renderSortIcon('namespace')}</span>
                </th>
              )}
              <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('name')}>
                <span className="inline-flex items-center gap-1">{tr('endpointSlicesPage.table.name', 'Name')}{renderSortIcon('name')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[180px] cursor-pointer" onClick={() => handleSort('service')}>
                <span className="inline-flex items-center gap-1">{tr('endpointSlicesPage.table.service', 'Service')}{renderSortIcon('service')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('addressType')}>
                <span className="inline-flex items-center gap-1">{tr('endpointSlicesPage.table.addressType', 'Address Type')}{renderSortIcon('addressType')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[260px] cursor-pointer" onClick={() => handleSort('ports')}>
                <span className="inline-flex items-center gap-1">{tr('endpointSlicesPage.table.ports', 'Ports')}{renderSortIcon('ports')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[280px]">
                {tr('endpointSlicesPage.table.endpoints', 'Endpoints')}
              </th>
              <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('endpoints')}>
                <span className="inline-flex items-center gap-1">{tr('endpointSlicesPage.table.total', 'Total')}{renderSortIcon('endpoints')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('ready')}>
                <span className="inline-flex items-center gap-1">{tr('endpointSlicesPage.table.ready', 'Ready')}{renderSortIcon('ready')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[110px] cursor-pointer" onClick={() => handleSort('notReady')}>
                <span className="inline-flex items-center gap-1">{tr('endpointSlicesPage.table.notReady', 'Not Ready')}{renderSortIcon('notReady')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                <span className="inline-flex items-center gap-1">{tr('endpointSlicesPage.table.age', 'Age')}{renderSortIcon('age')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {pagedEndpointSlices.map((es, idx) => {
              const notReady = resolveNotReadyCount(es)
              return (
                <tr
                    ref={idx === 0 ? firstRowRef : undefined}
                  key={`${es.namespace}/${es.name}`}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'EndpointSlice',
                    name: es.name,
                    namespace: es.namespace,
                    rawJson: endpointSliceToRawJson(es),
                  })}
                >
                  {showNamespaceColumn && <td className="py-3 px-4 text-xs font-mono">{es.namespace}</td>}
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{es.name}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{es.service_name || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{es.address_type || '-'}</td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{formatPorts(es.ports)}</span></td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{formatEndpointPreview(es)}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{es.endpoints_total || 0}</td>
                  <td className="py-3 px-4 text-xs font-mono">{es.endpoints_ready || 0}</td>
                  <td className="py-3 px-4 text-xs font-mono">{notReady}</td>
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(es.created_at)}</td>
                </tr>
              )
            })}
            {isLoading && (
              <tr>
                <td colSpan={showNamespaceColumn ? 11 : 10} className="py-10 px-4 text-center text-slate-400">
                  <div className="inline-flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading...
                  </div>
                </td>
              </tr>
            )}

            {sortedEndpointSlicesLength === 0 && !isLoading && (
              <tr>
                <td colSpan={showNamespaceColumn ? 11 : 10} className="py-6 px-4 text-center text-slate-400">
                  {tr('endpointSlicesPage.noResults', 'No endpoint slices found.')}
                </td>
              </tr>
            )}
          </tbody>
            <AdaptiveTableFillerRows count={rowsPerPage - pagedEndpointSlices.length} columnCount={9 + (showNamespaceColumn ? 1 : 0)} />
        </table>
      </div>

      {sortedEndpointSlicesLength > 0 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
          <div className="text-xs text-slate-400">
            {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
              start: (currentPage - 1) * rowsPerPage + 1,
              end: Math.min(currentPage * rowsPerPage, sortedEndpointSlicesLength),
              total: sortedEndpointSlicesLength,
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
