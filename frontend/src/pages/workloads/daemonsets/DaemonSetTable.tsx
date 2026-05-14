// DaemonSet 목록 테이블 + sort 헤더 + pagination
//
// frontend/src/pages/workloads/DaemonSets.tsx 의 table JSX (sort header + tbody +
// 빈/로딩 상태 + pagination footer) 추출. useAdaptiveTable 의 ref/rowsPerPage
// 는 부모에서 hook 호출 후 props 로 전달 (DOM 연결을 위해).

import type { Dispatch, RefObject, SetStateAction } from 'react'
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import type { DaemonSetInfo } from '@/services/api'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import {
  formatAge,
  getDaemonSetStatusColor,
  daemonSetToWorkloadRawJson,
  type SortKey,
} from './daemonSetHelpers'

interface OpenDetailArgs {
  kind: string
  name: string
  namespace: string
  rawJson?: Record<string, unknown>
}

interface Props {
  pagedDaemonSets: DaemonSetInfo[]
  sortedDaemonSetsLength: number
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

export function DaemonSetTable({
  pagedDaemonSets,
  sortedDaemonSetsLength,
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
                <th className="text-left py-3 px-4 w-[140px]">{tr('daemonsets.table.namespace', 'Namespace')}</th>
              )}
              <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('name')}>
                <span className="inline-flex items-center gap-1">
                  {tr('daemonsets.table.name', 'Name')}{renderSortIcon('name')}
                </span>
              </th>
              <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('ready')}>
                <span className="inline-flex items-center gap-1">
                  {tr('daemonsets.table.ready', 'Ready')}{renderSortIcon('ready')}
                </span>
              </th>
              <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('current')}>
                <span className="inline-flex items-center gap-1">
                  {tr('daemonsets.table.current', 'Current')}{renderSortIcon('current')}
                </span>
              </th>
              <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('desired')}>
                <span className="inline-flex items-center gap-1">
                  {tr('daemonsets.table.desired', 'Desired')}{renderSortIcon('desired')}
                </span>
              </th>
              <th className="text-left py-3 px-4 w-[95px] cursor-pointer" onClick={() => handleSort('updated')}>
                <span className="inline-flex items-center gap-1">
                  {tr('daemonsets.table.updated', 'Updated')}{renderSortIcon('updated')}
                </span>
              </th>
              <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('available')}>
                <span className="inline-flex items-center gap-1">
                  {tr('daemonsets.table.available', 'Available')}{renderSortIcon('available')}
                </span>
              </th>
              <th className="text-left py-3 px-4 w-[130px] cursor-pointer" onClick={() => handleSort('status')}>
                <span className="inline-flex items-center gap-1">
                  {tr('daemonsets.table.status', 'Status')}{renderSortIcon('status')}
                </span>
              </th>
              <th className="text-left py-3 px-4 w-[200px]">{tr('daemonsets.table.nodeSelector', 'Node Selector')}</th>
              <th className="text-left py-3 px-4 w-[230px] cursor-pointer" onClick={() => handleSort('images')}>
                <span className="inline-flex items-center gap-1">
                  {tr('daemonsets.table.images', 'Images')}{renderSortIcon('images')}
                </span>
              </th>
              <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                <span className="inline-flex items-center gap-1">
                  {tr('daemonsets.table.age', 'Age')}{renderSortIcon('age')}
                </span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {pagedDaemonSets.map((daemonset, idx) => (
              <tr
                    ref={idx === 0 ? firstRowRef : undefined}
                key={`${daemonset.namespace}/${daemonset.name}`}
                className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                onClick={() => openDetail({
                  kind: 'DaemonSet',
                  name: daemonset.name,
                  namespace: daemonset.namespace,
                  rawJson: daemonSetToWorkloadRawJson(daemonset),
                })}
              >
                {showNamespaceColumn && <td className="py-3 px-4 text-xs font-mono">{daemonset.namespace}</td>}
                <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{daemonset.name}</span></td>
                <td className="py-3 px-4 text-xs font-mono">{daemonset.ready}/{daemonset.desired}</td>
                <td className="py-3 px-4 text-xs font-mono">{daemonset.current}</td>
                <td className="py-3 px-4 text-xs font-mono">{daemonset.desired}</td>
                <td className="py-3 px-4 text-xs font-mono">{daemonset.updated}</td>
                <td className="py-3 px-4 text-xs font-mono">{daemonset.available}</td>
                <td className="py-3 px-4">
                  <span className={`badge ${getDaemonSetStatusColor(daemonset.status)}`}>{daemonset.status}</span>
                </td>
                <td className="py-3 px-4 text-xs font-mono">
                  <span className="block truncate">
                    {Object.entries(daemonset.node_selector || {}).map(([k, v]) => `${k}=${v}`).join(', ') || '-'}
                  </span>
                </td>
                <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{(daemonset.images || []).join(', ') || '-'}</span></td>
                <td className="py-3 px-4 text-xs font-mono">{formatAge(daemonset.created_at)}</td>
              </tr>
            ))}
            {isLoading && (
              <tr>
                <td colSpan={showNamespaceColumn ? 12 : 11} className="py-10 px-4 text-center text-slate-400">
                  <div className="inline-flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading...
                  </div>
                </td>
              </tr>
            )}

            {sortedDaemonSetsLength === 0 && !isLoading && (
              <tr>
                <td colSpan={showNamespaceColumn ? 12 : 11} className="py-6 px-4 text-center text-slate-400">
                  {tr('daemonsets.noResults', 'No daemonsets found.')}
                </td>
              </tr>
            )}
          </tbody>
            <AdaptiveTableFillerRows count={rowsPerPage - pagedDaemonSets.length} columnCount={10 + (showNamespaceColumn ? 1 : 0)} />
        </table>
      </div>
      {sortedDaemonSetsLength > 0 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
          <div className="text-xs text-slate-400">
            {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
              start: (currentPage - 1) * rowsPerPage + 1,
              end: Math.min(currentPage * rowsPerPage, sortedDaemonSetsLength),
              total: sortedDaemonSetsLength,
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
            <span className="text-xs text-slate-300 min-w-[72px] text-center">
              {currentPage} / {totalPages}
            </span>
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
