// StatefulSet 목록 테이블 + sort 헤더 + pagination
//
// frontend/src/pages/workloads/StatefulSets.tsx 의 table JSX (sort header +
// tbody + 빈/로딩 상태 + pagination footer) 추출. pageSize 는 부모의 resize
// useEffect 가 계산 후 props 전달 (useAdaptiveTable 미사용 — 다른 9 페이지와 다름).

import type { Dispatch, SetStateAction } from 'react'
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import type { StatefulSetInfo } from '@/services/api'
import {
  formatAge,
  getStatusColor,
  type SortKey,
} from './statefulSetHelpers'

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
  pageSize: number
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
  pageSize,
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
    <div className="card flex-1 min-h-0 flex flex-col">
      <div className="overflow-x-auto flex-1 min-h-0">
      <table className="w-full text-sm min-w-[980px] table-fixed">
        <thead className="text-slate-400">
          <tr>
            {showNamespaceColumn && <th className="text-left py-3 px-4 w-[15%]">{tr('statefulsets.table.namespace', 'Namespace')}</th>}
            <th className="text-left py-3 px-4 w-[20%] cursor-pointer" onClick={() => handleSort('name')}>
              <span className="inline-flex items-center gap-1">{tr('statefulsets.table.name', 'Name')}{renderSortIcon('name')}</span>
            </th>
            <th className="text-left py-3 px-4 w-[10%] cursor-pointer" onClick={() => handleSort('ready')}>
              <span className="inline-flex items-center gap-1">{tr('statefulsets.table.ready', 'Ready')}{renderSortIcon('ready')}</span>
            </th>
            <th className="text-left py-3 px-4 w-[11%] cursor-pointer" onClick={() => handleSort('upToDate')}>
              <span className="inline-flex items-center gap-1">{tr('statefulsets.table.upToDate', 'Up to date')}{renderSortIcon('upToDate')}</span>
            </th>
            <th className="text-left py-3 px-4 w-[11%] cursor-pointer" onClick={() => handleSort('available')}>
              <span className="inline-flex items-center gap-1">{tr('statefulsets.table.available', 'Available')}{renderSortIcon('available')}</span>
            </th>
            <th className="text-left py-3 px-4 w-[10%] cursor-pointer" onClick={() => handleSort('status')}>
              <span className="inline-flex items-center gap-1">{tr('statefulsets.table.status', 'Status')}{renderSortIcon('status')}</span>
            </th>
            <th className="text-left py-3 px-4 w-[10%] cursor-pointer" onClick={() => handleSort('age')}>
              <span className="inline-flex items-center gap-1">{tr('statefulsets.table.age', 'Age')}{renderSortIcon('age')}</span>
            </th>
            <th className="text-left py-3 px-4 w-[13%] cursor-pointer" onClick={() => handleSort('service')}>
              <span className="inline-flex items-center gap-1">{tr('statefulsets.table.service', 'Service')}{renderSortIcon('service')}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-700">
          {paged.map((sts: StatefulSetInfo) => (
            <tr
              key={`${sts.namespace}/${sts.name}`}
              className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
              onClick={() => openDetail({ kind: 'StatefulSet', name: sts.name, namespace: sts.namespace })}
            >
              {showNamespaceColumn && <td className="py-3 px-4 font-mono text-xs truncate">{sts.namespace}</td>}
              <td className="py-3 px-4 font-medium text-white">
                <span className="block truncate">{sts.name}</span>
              </td>
              <td className="py-3 px-4">{`${sts.ready_replicas ?? 0}/${sts.replicas ?? 0}`}</td>
              <td className="py-3 px-4">{`${sts.updated_replicas ?? sts.current_replicas ?? 0}/${sts.replicas ?? 0}`}</td>
              <td className="py-3 px-4">{sts.available_replicas ?? 0}</td>
              <td className="py-3 px-4">
                <span className={`badge ${getStatusColor(sts.status)}`}>{sts.status || '-'}</span>
              </td>
              <td className="py-3 px-4 font-mono text-xs">{formatAge(sts.created_at)}</td>
              <td className="py-3 px-4 text-xs font-mono truncate">{sts.service_name || '-'}</td>
            </tr>
          ))}
          {isLoading && (
            <tr>
              <td colSpan={showNamespaceColumn ? 8 : 7} className="py-10 px-4 text-center text-slate-400">
                <div className="inline-flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Loading...
                </div>
              </td>
            </tr>
          )}
          {!isLoading && paged.length === 0 && (
            <tr>
              <td colSpan={showNamespaceColumn ? 8 : 7} className="py-6 px-4 text-center text-slate-400">
                {tr('statefulsets.noResults', 'No StatefulSets found.')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </div>
      <div className="flex items-center justify-between text-xs text-slate-400 px-4 py-3 border-t border-slate-700 shrink-0">
        <span>
          {filteredLength === 0
            ? tr('statefulsets.paging.empty', '0 items')
            : tr('statefulsets.paging.range', '{{from}}-{{to}} / {{total}}', {
                from: (currentPage - 1) * pageSize + 1,
                to: Math.min(currentPage * pageSize, filteredLength),
                total: filteredLength,
              })}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage <= 1}
            className="px-2 py-1 rounded border border-slate-700 disabled:opacity-40"
          >
            {tr('statefulsets.paging.prev', 'Prev')}
          </button>
          <span>{currentPage} / {totalPages}</span>
          <button
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage >= totalPages}
            className="px-2 py-1 rounded border border-slate-700 disabled:opacity-40"
          >
            {tr('statefulsets.paging.next', 'Next')}
          </button>
        </div>
      </div>
    </div>
  )
}
