// Job 목록 테이블 + sort 헤더 + pagination
//
// frontend/src/pages/workloads/Jobs.tsx 의 table JSX (sort header + tbody +
// 빈/로딩 상태 + pagination footer) 추출. useAdaptiveTable 의 ref/rowsPerPage
// 는 부모에서 hook 호출 후 props 로 전달 (DOM 연결을 위해).

import type { Dispatch, RefObject, SetStateAction } from 'react'
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import type { JobInfo } from '@/services/api'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import {
  formatAge,
  formatDuration,
  getJobStatusColor,
  jobToWorkloadRawJson,
  type SortKey,
} from './jobHelpers'

interface OpenDetailArgs {
  kind: string
  name: string
  namespace: string
  rawJson?: Record<string, unknown>
}

interface Props {
  pagedJobs: JobInfo[]
  sortedJobsLength: number
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

export function JobTable({
  pagedJobs,
  sortedJobsLength,
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
        <table className="w-full text-sm min-w-[1260px] table-fixed">
          <thead ref={theadRef} className="text-slate-400">
            <tr>
              {showNamespaceColumn && <th className="text-left py-3 px-4 w-[140px]">{tr('jobs.table.namespace', 'Namespace')}</th>}
              <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('name')}>
                <span className="inline-flex items-center gap-1">{tr('jobs.table.name', 'Name')}{renderSortIcon('name')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[130px] cursor-pointer" onClick={() => handleSort('completions')}>
                <span className="inline-flex items-center gap-1">{tr('jobs.table.completions', 'Completions')}{renderSortIcon('completions')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[130px] cursor-pointer" onClick={() => handleSort('status')}>
                <span className="inline-flex items-center gap-1">{tr('jobs.table.status', 'Status')}{renderSortIcon('status')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('duration')}>
                <span className="inline-flex items-center gap-1">{tr('jobs.table.duration', 'Duration')}{renderSortIcon('duration')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[220px] cursor-pointer" onClick={() => handleSort('containers')}>
                <span className="inline-flex items-center gap-1">{tr('jobs.table.containers', 'Containers')}{renderSortIcon('containers')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[240px] cursor-pointer" onClick={() => handleSort('images')}>
                <span className="inline-flex items-center gap-1">{tr('jobs.table.images', 'Images')}{renderSortIcon('images')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('age')}>
                <span className="inline-flex items-center gap-1">{tr('jobs.table.age', 'Age')}{renderSortIcon('age')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {pagedJobs.map((job, idx) => (
              <tr
                    ref={idx === 0 ? firstRowRef : undefined}
                key={`${job.namespace}/${job.name}`}
                className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                onClick={() => openDetail({
                  kind: 'Job',
                  name: job.name,
                  namespace: job.namespace,
                  rawJson: jobToWorkloadRawJson(job),
                })}
              >
                {showNamespaceColumn && <td className="py-3 px-4 text-xs font-mono">{job.namespace}</td>}
                <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{job.name}</span></td>
                <td className="py-3 px-4 text-xs font-mono">
                  {(job.succeeded ?? 0)}/{(job.completions ?? '-')}
                </td>
                <td className="py-3 px-4">
                  <span className={`badge ${getJobStatusColor(job.status)}`}>{job.status || '-'}</span>
                </td>
                <td className="py-3 px-4 text-xs font-mono">{formatDuration(job.duration_seconds)}</td>
                <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{(job.containers || []).join(', ') || '-'}</span></td>
                <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{(job.images || []).join(', ') || '-'}</span></td>
                <td className="py-3 px-4 text-xs font-mono">{formatAge(job.created_at)}</td>
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

            {sortedJobsLength === 0 && !isLoading && (
              <tr>
                <td colSpan={showNamespaceColumn ? 8 : 7} className="py-6 px-4 text-center text-slate-400">
                  {tr('jobs.noResults', 'No jobs found.')}
                </td>
              </tr>
            )}
          </tbody>
            <AdaptiveTableFillerRows count={rowsPerPage - pagedJobs.length} columnCount={7 + (showNamespaceColumn ? 1 : 0)} />
        </table>
      </div>

      {sortedJobsLength > 0 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
          <div className="text-xs text-slate-400">
            {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
              start: (currentPage - 1) * rowsPerPage + 1,
              end: Math.min(currentPage * rowsPerPage, sortedJobsLength),
              total: sortedJobsLength,
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
