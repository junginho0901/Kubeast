// PersistentVolumes 목록 테이블 + sort 헤더 + pagination
//
// frontend/src/pages/storage/PersistentVolumes.tsx 의 table JSX (sort header
// + tbody + 빈/로딩 상태 + pagination footer) 추출. useAdaptiveTable 의 ref/
// rowsPerPage 는 부모에서 hook 호출 후 props 로 전달.
// cluster-scoped 라 namespace 컬럼 없음. **10 컬럼 모두 sortable** (가장 많은
// 컬럼 수): name/status/storageClass/capacity/accessModes/reclaimPolicy/
// claim/volumeMode/source/age. min-w-[1400px].

import type { Dispatch, RefObject, SetStateAction } from 'react'
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import type { PVInfo } from '@/services/api'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import {
  claimToText,
  formatAge,
  pvToRawJson,
  statusBadgeClass,
  type SortKey,
} from './pvHelpers'

interface OpenDetailArgs {
  kind: string
  name: string
  rawJson?: Record<string, unknown>
}

interface Props {
  pagedPVs: PVInfo[]
  sortedPVsLength: number
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

export function PVTable({
  pagedPVs,
  sortedPVsLength,
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
        <table className="w-full text-sm min-w-[1400px] table-fixed">
          <thead ref={theadRef} className="text-slate-400">
            <tr>
              <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('name')}>
                <span className="inline-flex items-center gap-1">{tr('pvs.table.name', 'Name')}{renderSortIcon('name')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('status')}>
                <span className="inline-flex items-center gap-1">{tr('pvs.table.status', 'Status')}{renderSortIcon('status')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[180px] cursor-pointer" onClick={() => handleSort('storageClass')}>
                <span className="inline-flex items-center gap-1">{tr('pvs.table.storageClass', 'StorageClass')}{renderSortIcon('storageClass')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[110px] cursor-pointer" onClick={() => handleSort('capacity')}>
                <span className="inline-flex items-center gap-1">{tr('pvs.table.capacity', 'Capacity')}{renderSortIcon('capacity')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[170px] cursor-pointer" onClick={() => handleSort('accessModes')}>
                <span className="inline-flex items-center gap-1">{tr('pvs.table.accessModes', 'Access Modes')}{renderSortIcon('accessModes')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[140px] cursor-pointer" onClick={() => handleSort('reclaimPolicy')}>
                <span className="inline-flex items-center gap-1">{tr('pvs.table.reclaimPolicy', 'Reclaim Policy')}{renderSortIcon('reclaimPolicy')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[180px] cursor-pointer" onClick={() => handleSort('claim')}>
                <span className="inline-flex items-center gap-1">{tr('pvs.table.claim', 'Claim')}{renderSortIcon('claim')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('volumeMode')}>
                <span className="inline-flex items-center gap-1">{tr('pvs.table.volumeMode', 'Volume Mode')}{renderSortIcon('volumeMode')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[190px] cursor-pointer" onClick={() => handleSort('source')}>
                <span className="inline-flex items-center gap-1">{tr('pvs.table.source', 'Source')}{renderSortIcon('source')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                <span className="inline-flex items-center gap-1">{tr('pvs.table.age', 'Age')}{renderSortIcon('age')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {pagedPVs.map((pv, idx) => (
              <tr
                    ref={idx === 0 ? firstRowRef : undefined}
                key={pv.name}
                className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                onClick={() => openDetail({
                  kind: 'PersistentVolume',
                  name: pv.name,
                  rawJson: pvToRawJson(pv),
                })}
              >
                <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{pv.name}</span></td>
                <td className="py-3 px-4">
                  <span className={`badge ${statusBadgeClass(pv.status)}`}>{pv.status || '-'}</span>
                </td>
                <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{pv.storage_class || '-'}</span></td>
                <td className="py-3 px-4 text-xs font-mono">{pv.capacity || '-'}</td>
                <td className="py-3 px-4 text-xs"><span className="block truncate">{(pv.access_modes || []).join(', ') || '-'}</span></td>
                <td className="py-3 px-4 text-xs"><span className="block truncate">{pv.reclaim_policy || '-'}</span></td>
                <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{claimToText(pv.claim_ref)}</span></td>
                <td className="py-3 px-4 text-xs">{pv.volume_mode || '-'}</td>
                <td className="py-3 px-4 text-xs"><span className="block truncate">{pv.source || pv.driver || '-'}</span></td>
                <td className="py-3 px-4 text-xs font-mono">{formatAge(pv.created_at)}</td>
              </tr>
            ))}
            {isLoading && (
              <tr>
                <td colSpan={10} className="py-10 px-4 text-center text-slate-400">
                  <div className="inline-flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading...
                  </div>
                </td>
              </tr>
            )}

            {sortedPVsLength === 0 && !isLoading && (
              <tr>
                <td colSpan={10} className="py-6 px-4 text-center text-slate-400">
                  {tr('pvs.noResults', 'No PVs found.')}
                </td>
              </tr>
            )}
          </tbody>
            <AdaptiveTableFillerRows count={rowsPerPage - pagedPVs.length} columnCount={10} />
        </table>
      </div>

      {sortedPVsLength > 0 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
          <div className="text-xs text-slate-400">
            {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
              start: (currentPage - 1) * rowsPerPage + 1,
              end: Math.min(currentPage * rowsPerPage, sortedPVsLength),
              total: sortedPVsLength,
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
