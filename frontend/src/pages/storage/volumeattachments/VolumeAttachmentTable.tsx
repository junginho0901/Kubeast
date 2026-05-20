// VolumeAttachments 목록 테이블 + sort 헤더 + pagination
//
// frontend/src/pages/storage/VolumeAttachments.tsx 의 table JSX (sort header +
// tbody + 빈/로딩 상태 + pagination footer) 추출. useAdaptiveTable 의 ref/
// rowsPerPage 는 부모에서 hook 호출 후 props 로 전달.
// cluster-scoped 라 namespace 컬럼 없음. 7 컬럼 모두 sortable.
// **PV/Node 컬럼이 별도 ResourceDetail 열기** (PersistentVolume/Node 도메인으로
// 점프 — stopPropagation 으로 row click 안 발생). pagination 키 분기
// (common.pageSummary / common.pageSummaryEmpty / common.prev / common.next).
// min-w-[900px]. isError 분기는 부모에서 처리 (table 위에 amber 경고).

import type { Dispatch, RefObject, SetStateAction } from 'react'
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import type { VolumeAttachmentInfo } from '@/services/api'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import {
  errorText,
  formatAge,
  statusBadgeClass,
  statusLabel,
  volumeAttachmentToRawJson,
  type SortKey,
} from './volumeAttachmentHelpers'

interface OpenDetailArgs {
  kind: string
  name: string
  namespace?: string
  rawJson?: Record<string, unknown>
}

interface Props {
  pagedVolumeAttachments: VolumeAttachmentInfo[]
  sortedVolumeAttachmentsLength: number
  isLoading: boolean
  sortKey: SortKey
  setSortKey: Dispatch<SetStateAction<SortKey>>
  sortDir: 'asc' | 'desc'
  setSortDir: Dispatch<SetStateAction<'asc' | 'desc'>>
  currentPage: number
  setCurrentPage: Dispatch<SetStateAction<number>>
  totalPages: number
  rowsPerPage: number
  tableBodyRef: RefObject<HTMLDivElement>
  theadRef: RefObject<HTMLTableSectionElement>
  firstRowRef: RefObject<HTMLTableRowElement>
  openDetail: (args: OpenDetailArgs) => void
  tr: (key: string, fallback: string, options?: Record<string, any>) => string
}

export function VolumeAttachmentTable({
  pagedVolumeAttachments,
  sortedVolumeAttachmentsLength,
  isLoading,
  sortKey,
  setSortKey,
  sortDir,
  setSortDir,
  currentPage,
  setCurrentPage,
  totalPages,
  rowsPerPage,
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
    <>
      <div ref={tableBodyRef} className="overflow-x-auto flex-1 min-h-0">
        <table className="w-full min-w-[900px] text-sm">
          <thead ref={theadRef} className="text-slate-400">
            <tr>
              <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => handleSort('name')}>
                <span className="inline-flex items-center gap-1">{tr('volumeattachments.table.name', 'Name')}{renderSortIcon('name')}</span>
              </th>
              <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => handleSort('attacher')}>
                <span className="inline-flex items-center gap-1">{tr('volumeattachments.table.attacher', 'Attacher')}{renderSortIcon('attacher')}</span>
              </th>
              <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => handleSort('pv')}>
                <span className="inline-flex items-center gap-1">{tr('volumeattachments.table.persistentVolume', 'Persistent Volume')}{renderSortIcon('pv')}</span>
              </th>
              <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => handleSort('node')}>
                <span className="inline-flex items-center gap-1">{tr('volumeattachments.table.node', 'Node')}{renderSortIcon('node')}</span>
              </th>
              <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => handleSort('attached')}>
                <span className="inline-flex items-center gap-1">{tr('volumeattachments.table.attached', 'Attached')}{renderSortIcon('attached')}</span>
              </th>
              <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => handleSort('error')}>
                <span className="inline-flex items-center gap-1">{tr('volumeattachments.table.error', 'Error')}{renderSortIcon('error')}</span>
              </th>
              <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => handleSort('age')}>
                <span className="inline-flex items-center gap-1">{tr('volumeattachments.table.age', 'Age')}{renderSortIcon('age')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {pagedVolumeAttachments.map((va, idx) => {
              const status = statusLabel(va)
              const errors = errorText(va)
              return (
                <tr
                  key={va.name}
                  ref={idx === 0 ? firstRowRef : undefined}
                  className="hover:bg-slate-800/30 cursor-pointer"
                  onClick={() => openDetail({ kind: 'VolumeAttachment', name: va.name, rawJson: volumeAttachmentToRawJson(va) })}
                >
                  <td className="py-3 px-4 text-white font-mono break-all">{va.name}</td>
                  <td className="py-3 px-4 text-slate-300 break-all">{va.attacher || '-'}</td>
                  <td className="py-3 px-4 text-slate-300">
                    {va.persistent_volume_name ? (
                      <button
                        type="button"
                        className="text-cyan-300 hover:text-cyan-200 underline underline-offset-2 break-all text-left"
                        onClick={(e) => {
                          e.stopPropagation()
                          openDetail({ kind: 'PersistentVolume', name: va.persistent_volume_name as string })
                        }}
                      >
                        {va.persistent_volume_name}
                      </button>
                    ) : '-'}
                  </td>
                  <td className="py-3 px-4 text-slate-300">
                    {va.node_name ? (
                      <button
                        type="button"
                        className="text-cyan-300 hover:text-cyan-200 underline underline-offset-2 break-all text-left"
                        onClick={(e) => {
                          e.stopPropagation()
                          openDetail({ kind: 'Node', name: va.node_name as string })
                        }}
                      >
                        {va.node_name}
                      </button>
                    ) : '-'}
                  </td>
                  <td className="py-3 px-4">
                    <span className={`badge ${statusBadgeClass(status)}`}>{status}</span>
                  </td>
                  <td className="py-3 px-4 text-slate-300 max-w-[320px]">
                    <span className="block truncate" title={errors}>{errors}</span>
                  </td>
                  <td className="py-3 px-4 text-slate-400">{formatAge(va.created_at)}</td>
                </tr>
              )
            })}

            {!isLoading && pagedVolumeAttachments.length === 0 && (
              <tr>
                <td colSpan={7} className="py-10 text-center text-slate-400">
                  {tr('volumeattachments.noResults', 'No VolumeAttachments found.')}
                </td>
              </tr>
            )}

            {isLoading && (
              <tr>
                <td colSpan={7} className="py-10 px-4 text-center text-slate-400">
                  <div className="inline-flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading...
                  </div>
                </td>
              </tr>
            )}
          </tbody>
          <AdaptiveTableFillerRows count={rowsPerPage - pagedVolumeAttachments.length} columnCount={7} />
        </table>
      </div>

      <div className="px-4 py-3 border-t border-slate-800 flex items-center justify-between shrink-0">
        <p className="text-xs text-slate-400">
          {sortedVolumeAttachmentsLength > 0
            ? tr('common.pageSummary', '{{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedVolumeAttachmentsLength),
                total: sortedVolumeAttachmentsLength,
              })
            : tr('common.pageSummaryEmpty', '0 of 0')}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
            disabled={currentPage <= 1}
            className="btn btn-secondary px-2 py-1 text-xs disabled:opacity-50"
          >
            {tr('common.prev', 'Previous')}
          </button>
          <span className="text-xs text-slate-300 min-w-[72px] text-center">{currentPage} / {totalPages}</span>
          <button
            type="button"
            onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))}
            disabled={currentPage >= totalPages}
            className="btn btn-secondary px-2 py-1 text-xs disabled:opacity-50"
          >
            {tr('common.next', 'Next')}
          </button>
        </div>
      </div>
    </>
  )
}
