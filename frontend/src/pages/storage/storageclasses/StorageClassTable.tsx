// StorageClasses 목록 테이블 + sort 헤더 + pagination
//
// frontend/src/pages/storage/StorageClasses.tsx 의 table JSX (sort header +
// tbody + 빈/로딩 상태 + pagination footer) 추출. useAdaptiveTable 의 ref/
// rowsPerPage 는 부모에서 hook 호출 후 props 로 전달.
// cluster-scoped 라 namespace 컬럼 없음. 7 sortable 컬럼 (name/provisioner/
// default/reclaimPolicy/bindingMode/allowExpansion/age) + parameters 컬럼
// (Object.keys count 만, sortable 아님 — 원본 보존). min-w-[1300px].
// Default 컬럼은 green check icon + 'Yes', AllowVolumeExpansion 은 Yes/No.

import type { Dispatch, RefObject, SetStateAction } from 'react'
import { CheckCircle, ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import type { StorageClassInfo } from '@/services/api'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import {
  formatAge,
  storageClassToRawJson,
  type SortKey,
} from './storageClassHelpers'

interface OpenDetailArgs {
  kind: string
  name: string
  rawJson?: Record<string, unknown>
}

interface Props {
  pagedStorageClasses: StorageClassInfo[]
  sortedStorageClassesLength: number
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

export function StorageClassTable({
  pagedStorageClasses,
  sortedStorageClassesLength,
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
        <table className="w-full text-sm min-w-[1300px] table-fixed">
          <thead ref={theadRef} className="text-slate-400">
            <tr>
              <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('name')}>
                <span className="inline-flex items-center gap-1">{tr('storageclasses.table.name', 'Name')}{renderSortIcon('name')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[260px] cursor-pointer" onClick={() => handleSort('provisioner')}>
                <span className="inline-flex items-center gap-1">{tr('storageclasses.table.provisioner', 'Provisioner')}{renderSortIcon('provisioner')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('default')}>
                <span className="inline-flex items-center gap-1">{tr('storageclasses.table.default', 'Default')}{renderSortIcon('default')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[160px] cursor-pointer" onClick={() => handleSort('reclaimPolicy')}>
                <span className="inline-flex items-center gap-1">{tr('storageclasses.table.reclaimPolicy', 'Reclaim Policy')}{renderSortIcon('reclaimPolicy')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[190px] cursor-pointer" onClick={() => handleSort('bindingMode')}>
                <span className="inline-flex items-center gap-1">{tr('storageclasses.table.volumeBindingMode', 'Volume Binding Mode')}{renderSortIcon('bindingMode')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[170px] cursor-pointer" onClick={() => handleSort('allowExpansion')}>
                <span className="inline-flex items-center gap-1">{tr('storageclasses.table.allowVolumeExpansion', 'Allow Volume Expansion')}{renderSortIcon('allowExpansion')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[120px]">{tr('storageclasses.table.parameters', 'Parameters')}</th>
              <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                <span className="inline-flex items-center gap-1">{tr('storageclasses.table.age', 'Age')}{renderSortIcon('age')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {pagedStorageClasses.map((sc, idx) => (
              <tr
                    ref={idx === 0 ? firstRowRef : undefined}
                key={sc.name}
                className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                onClick={() => openDetail({
                  kind: 'StorageClass',
                  name: sc.name,
                  rawJson: storageClassToRawJson(sc),
                })}
              >
                <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{sc.name}</span></td>
                <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{sc.provisioner || '-'}</span></td>
                <td className="py-3 px-4 text-xs">
                  {sc.is_default ? (
                    <span className="inline-flex items-center gap-1 text-emerald-300">
                      <CheckCircle className="w-3.5 h-3.5" />
                      {tr('common.yes', 'Yes')}
                    </span>
                  ) : '-'}
                </td>
                <td className="py-3 px-4 text-xs"><span className="block truncate">{sc.reclaim_policy || '-'}</span></td>
                <td className="py-3 px-4 text-xs"><span className="block truncate">{sc.volume_binding_mode || '-'}</span></td>
                <td className="py-3 px-4 text-xs">{sc.allow_volume_expansion ? tr('common.yes', 'Yes') : tr('common.no', 'No')}</td>
                <td className="py-3 px-4 text-xs">{Object.keys(sc.parameters || {}).length}</td>
                <td className="py-3 px-4 text-xs font-mono">{formatAge(sc.created_at)}</td>
              </tr>
            ))}
            {isLoading && (
              <tr>
                <td colSpan={8} className="py-10 px-4 text-center text-slate-400">
                  <div className="inline-flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading...
                  </div>
                </td>
              </tr>
            )}

            {sortedStorageClassesLength === 0 && !isLoading && (
              <tr>
                <td colSpan={8} className="py-6 px-4 text-center text-slate-400">
                  {tr('storageclasses.noResults', 'No StorageClasses found.')}
                </td>
              </tr>
            )}
          </tbody>
            <AdaptiveTableFillerRows count={rowsPerPage - pagedStorageClasses.length} columnCount={8} />
        </table>
      </div>

      {sortedStorageClassesLength > 0 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
          <div className="text-xs text-slate-400">
            {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
              start: (currentPage - 1) * rowsPerPage + 1,
              end: Math.min(currentPage * rowsPerPage, sortedStorageClassesLength),
              total: sortedStorageClassesLength,
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
