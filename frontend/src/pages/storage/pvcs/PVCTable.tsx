// PersistentVolumeClaims 목록 테이블 + sort 헤더 + pagination
//
// frontend/src/pages/storage/PersistentVolumeClaims.tsx 의 table JSX (sort
// header + tbody + 빈/로딩 상태 + pagination footer) 추출. useAdaptiveTable
// 의 ref/rowsPerPage 는 부모에서 hook 호출 후 props 로 전달.
// 9 컬럼 (namespace + name + status + storageClass + volume + requested +
// capacity + accessModes + age) 모두 sortable. min-w-[1360px].
// status badge: bound=success / pending=warning / lost=error.

import type { Dispatch, RefObject, SetStateAction } from 'react'
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import type { PVCInfo } from '@/services/api'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import {
  formatAge,
  pvcToRawJson,
  type SortKey,
} from './pvcHelpers'

interface OpenDetailArgs {
  kind: string
  name: string
  namespace: string
  rawJson?: Record<string, unknown>
}

interface Props {
  pagedPVCs: PVCInfo[]
  sortedPVCsLength: number
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

export function PVCTable({
  pagedPVCs,
  sortedPVCsLength,
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
        <table className="w-full text-sm min-w-[1360px] table-fixed">
          <thead ref={theadRef} className="text-slate-400">
            <tr>
              {showNamespaceColumn && (
                <th className="text-left py-3 px-4 w-[140px] cursor-pointer" onClick={() => handleSort('namespace')}>
                  <span className="inline-flex items-center gap-1">{tr('pvcs.table.namespace', 'Namespace')}{renderSortIcon('namespace')}</span>
                </th>
              )}
              <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('name')}>
                <span className="inline-flex items-center gap-1">{tr('pvcs.table.name', 'Name')}{renderSortIcon('name')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('status')}>
                <span className="inline-flex items-center gap-1">{tr('pvcs.table.status', 'Status')}{renderSortIcon('status')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[180px] cursor-pointer" onClick={() => handleSort('storageClass')}>
                <span className="inline-flex items-center gap-1">{tr('pvcs.table.storageClass', 'StorageClass')}{renderSortIcon('storageClass')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('volume')}>
                <span className="inline-flex items-center gap-1">{tr('pvcs.table.volume', 'Volume')}{renderSortIcon('volume')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('requested')}>
                <span className="inline-flex items-center gap-1">{tr('pvcs.table.requested', 'Requested')}{renderSortIcon('requested')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('capacity')}>
                <span className="inline-flex items-center gap-1">{tr('pvcs.table.capacity', 'Capacity')}{renderSortIcon('capacity')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[170px] cursor-pointer" onClick={() => handleSort('accessModes')}>
                <span className="inline-flex items-center gap-1">{tr('pvcs.table.accessModes', 'Access Modes')}{renderSortIcon('accessModes')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                <span className="inline-flex items-center gap-1">{tr('pvcs.table.age', 'Age')}{renderSortIcon('age')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {pagedPVCs.map((pvc, idx) => (
              <tr
                    ref={idx === 0 ? firstRowRef : undefined}
                key={`${pvc.namespace}/${pvc.name}`}
                className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                onClick={() => openDetail({
                  kind: 'PersistentVolumeClaim',
                  name: pvc.name,
                  namespace: pvc.namespace,
                  rawJson: pvcToRawJson(pvc),
                })}
              >
                {showNamespaceColumn && <td className="py-3 px-4 text-xs font-mono">{pvc.namespace}</td>}
                <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{pvc.name}</span></td>
                <td className="py-3 px-4">
                  <span className={`badge ${String(pvc.status || '').toLowerCase() === 'bound' ? 'badge-success' : String(pvc.status || '').toLowerCase() === 'pending' ? 'badge-warning' : 'badge-error'}`}>
                    {pvc.status || '-'}
                  </span>
                </td>
                <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{pvc.storage_class || '-'}</span></td>
                <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{pvc.volume_name || '-'}</span></td>
                <td className="py-3 px-4 text-xs font-mono">{pvc.requested || '-'}</td>
                <td className="py-3 px-4 text-xs font-mono">{pvc.capacity || '-'}</td>
                <td className="py-3 px-4 text-xs"><span className="block truncate">{(pvc.access_modes || []).join(', ') || '-'}</span></td>
                <td className="py-3 px-4 text-xs font-mono">{formatAge(pvc.created_at)}</td>
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

            {sortedPVCsLength === 0 && !isLoading && (
              <tr>
                <td colSpan={showNamespaceColumn ? 9 : 8} className="py-6 px-4 text-center text-slate-400">
                  {tr('pvcs.noResults', 'No PVCs found.')}
                </td>
              </tr>
            )}
          </tbody>
            <AdaptiveTableFillerRows count={rowsPerPage - pagedPVCs.length} columnCount={8 + (showNamespaceColumn ? 1 : 0)} />
        </table>
      </div>

      {sortedPVCsLength > 0 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
          <div className="text-xs text-slate-400">
            {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
              start: (currentPage - 1) * rowsPerPage + 1,
              end: Math.min(currentPage * rowsPerPage, sortedPVCsLength),
              total: sortedPVCsLength,
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
