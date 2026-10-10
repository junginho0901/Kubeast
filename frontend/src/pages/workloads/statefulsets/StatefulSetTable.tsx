// StatefulSet 목록 테이블 + sort 헤더 + pagination
//
// frontend/src/pages/workloads/StatefulSets.tsx 의 table JSX (sort header +
// tbody + 빈/로딩 상태 + pagination footer) 추출. useAdaptiveTable 의 ref/rowsPerPage
// 는 부모에서 hook 호출 후 props 로 전달 (DOM 연결을 위해).

import type { Dispatch, RefObject, SetStateAction } from 'react'
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import type { StatefulSetInfo } from '@/services/api'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { ListPager } from '@/components/ListPager'
import { TableEmptyRow } from '@/components/TableEmptyRow'
import {
  formatAge,
  getStatusColor,
  type SortKey,
} from './statefulSetHelpers'
import { workloadStatusLabel, workloadStatusTitle } from '@/utils/workloadStatus'
import { Trans } from 'react-i18next'

interface OpenDetailArgs {
  kind: string
  name: string
  namespace: string
}

interface Props {
  paged: StatefulSetInfo[]
  filteredLength: number
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
  tableContainerRef: RefObject<HTMLDivElement | null>
  tableBodyRef: RefObject<HTMLDivElement | null>
  theadRef: RefObject<HTMLTableSectionElement | null>
  firstRowRef: RefObject<HTMLTableRowElement | null>
  searching: boolean
  openDetail: (args: OpenDetailArgs) => void
  tr: (key: string, fallback: string, options?: Record<string, any>) => string
}

export function StatefulSetTable({
  paged,
  filteredLength,
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
  searching,
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

  const columnCount = 7 + (showNamespaceColumn ? 1 : 0)

  return (
    <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
      <div ref={tableBodyRef} className="overflow-x-auto flex-1 min-h-0">
        <table className="w-full text-sm min-w-[1040px] table-fixed">
          <thead ref={theadRef} className="text-slate-400">
            <tr>
              {showNamespaceColumn && <th className="col-low text-left py-3 px-4 w-[150px]">{tr('statefulsets.table.namespace', 'Namespace')}</th>}
              <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('name')}>
                <span className="inline-flex items-center gap-1">{tr('statefulsets.table.name', 'Name')}{renderSortIcon('name')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('ready')}>
                <span className="inline-flex items-center gap-1">{tr('statefulsets.table.ready', 'Ready')}{renderSortIcon('ready')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[110px] cursor-pointer" onClick={() => handleSort('upToDate')}>
                <span className="inline-flex items-center gap-1">{tr('statefulsets.table.upToDate', 'Up to date')}{renderSortIcon('upToDate')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('available')}>
                <span className="inline-flex items-center gap-1">{tr('statefulsets.table.available', 'Available')}{renderSortIcon('available')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('status')}>
                <span className="inline-flex items-center gap-1">{tr('statefulsets.table.status', 'Status')}{renderSortIcon('status')}</span>
              </th>
              <th className="col-optional text-left py-3 px-4 w-[160px] cursor-pointer" onClick={() => handleSort('service')}>
                <span className="inline-flex items-center gap-1">{tr('statefulsets.table.service', 'Service')}{renderSortIcon('service')}</span>
              </th>
              <th className="col-low text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('age')}>
                <span className="inline-flex items-center gap-1">{tr('statefulsets.table.age', 'Age')}{renderSortIcon('age')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {paged.map((sts: StatefulSetInfo, idx) => (
              <tr
                ref={idx === 0 ? firstRowRef : undefined}
                key={`${sts.namespace}/${sts.name}`}
                className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                onClick={() => openDetail({ kind: 'StatefulSet', name: sts.name, namespace: sts.namespace })}
              >
                {showNamespaceColumn && <td className="col-low py-3 px-4 text-xs font-mono" title={sts.namespace}>{sts.namespace}</td>}
                <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{sts.name}</span></td>
                <td className="py-3 px-4 text-xs font-mono">{`${sts.ready_replicas ?? 0}/${sts.replicas ?? 0}`}</td>
                <td className="py-3 px-4 text-xs font-mono">{`${sts.updated_replicas ?? sts.current_replicas ?? 0}/${sts.replicas ?? 0}`}</td>
                <td className="py-3 px-4 text-xs font-mono">{sts.available_replicas ?? 0}</td>
                <td className="py-3 px-4">
                  <span className={`badge ${getStatusColor(sts.status)}`} title={workloadStatusTitle(sts.status)}>{workloadStatusLabel(tr, sts.status)}</span>
                </td>
                <td className="col-optional py-3 px-4 text-xs font-mono"><span className="block truncate">{sts.service_name || '-'}</span></td>
                <td className="col-low py-3 px-4 text-xs font-mono">{formatAge(sts.created_at)}</td>
              </tr>
            ))}
            {isLoading && (
              <tr>
                <td colSpan={columnCount} className="py-10 px-4 text-center text-slate-400">
                  <div className="inline-flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <Trans i18nKey="common.loading" />
                  </div>
                </td>
              </tr>
            )}
            {!isLoading && paged.length === 0 && (
              <TableEmptyRow colSpan={columnCount} resource="statefulsets" searching={searching} />
            )}
          </tbody>
          <AdaptiveTableFillerRows count={rowsPerPage - paged.length} columnCount={columnCount} />
        </table>
      </div>
      <ListPager currentPage={currentPage} totalPages={totalPages} total={filteredLength} rowsPerPage={rowsPerPage} onPageChange={setCurrentPage} />
    </div>
  )
}
