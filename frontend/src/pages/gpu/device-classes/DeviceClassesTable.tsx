import { useTranslation } from 'react-i18next'
import { Loader2, ChevronDown, ChevronUp } from 'lucide-react'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import type { DeviceClassItem } from '@/services/api'
import { deviceClassToRawJson, formatAge, type SortKey } from './deviceClassesHelpers'

interface Props {
  sortedDeviceClasses: DeviceClassItem[]
  pagedDeviceClasses: DeviceClassItem[]
  isLoading: boolean
  sortKey: SortKey
  sortDir: 'asc' | 'desc'
  onSort: (key: NonNullable<SortKey>) => void
  currentPage: number
  totalPages: number
  rowsPerPage: number
  setCurrentPage: (updater: (prev: number) => number) => void
  tableContainerRef: React.RefObject<HTMLDivElement>
  tableBodyRef: React.RefObject<HTMLDivElement>
  theadRef: React.RefObject<HTMLTableSectionElement>
  firstRowRef: React.RefObject<HTMLTableRowElement>
}

export default function DeviceClassesTable({
  sortedDeviceClasses,
  pagedDeviceClasses,
  isLoading,
  sortKey,
  sortDir,
  onSort,
  currentPage,
  totalPages,
  rowsPerPage,
  setCurrentPage,
  tableContainerRef,
  tableBodyRef,
  theadRef,
  firstRowRef,
}: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const { open: openDetail } = useResourceDetail()

  const renderSortIcon = (key: NonNullable<SortKey>) => {
    if (sortKey !== key) return null
    return sortDir === 'asc'
      ? <ChevronUp className="w-3.5 h-3.5 text-slate-300" />
      : <ChevronDown className="w-3.5 h-3.5 text-slate-300" />
  }

  return (
    <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
      <div ref={tableBodyRef} className="overflow-x-auto flex-1 min-h-0">
        <table className="w-full text-sm min-w-[940px] table-fixed">
          <thead ref={theadRef} className="text-slate-400">
            <tr>
              <th className="text-left py-3 px-4 w-[280px] cursor-pointer" onClick={() => onSort('name')}>
                <span className="inline-flex items-center gap-1">{tr('deviceClassesPage.table.name', 'Name')}{renderSortIcon('name')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[150px] cursor-pointer" onClick={() => onSort('selectors')}>
                <span className="inline-flex items-center gap-1">{tr('deviceClassesPage.table.selectors', 'Selectors')}{renderSortIcon('selectors')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[320px] cursor-pointer" onClick={() => onSort('conditions')}>
                <span className="inline-flex items-center gap-1">{tr('deviceClassesPage.table.conditions', 'Conditions')}{renderSortIcon('conditions')}</span>
              </th>
              <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => onSort('age')}>
                <span className="inline-flex items-center gap-1">{tr('deviceClassesPage.table.age', 'Age')}{renderSortIcon('age')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {pagedDeviceClasses.map((item, idx) => (
              <tr
                ref={idx === 0 ? firstRowRef : undefined}
                key={item.name}
                className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                onClick={() => openDetail({
                  kind: 'DeviceClass',
                  name: item.name,
                  rawJson: deviceClassToRawJson(item),
                })}
              >
                <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{item.name}</span></td>
                <td className="py-3 px-4 text-xs">{item.selector_count ?? 0}</td>
                <td className="py-3 px-4 text-xs">
                  <span className="block truncate">
                    {Array.isArray(item.conditions) && item.conditions.length > 0
                      ? item.conditions.map((c, i) => {
                          const type = String(c?.type || 'Unknown')
                          const status = String(c?.status || '').toLowerCase()
                          const isTrue = status === 'true'
                          return (
                            <span
                              key={i}
                              className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium mr-1 ${
                                isTrue
                                  ? 'bg-emerald-900/40 text-emerald-300 border border-emerald-700/40'
                                  : 'bg-red-900/40 text-red-300 border border-red-700/40'
                              }`}
                            >
                              {type}
                            </span>
                          )
                        })
                      : '-'}
                  </span>
                </td>
                <td className="py-3 px-4 text-xs font-mono">{formatAge(item.created_at)}</td>
              </tr>
            ))}
            {isLoading && (
              <tr>
                <td colSpan={4} className="py-10 px-4 text-center text-slate-400">
                  <div className="inline-flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading...
                  </div>
                </td>
              </tr>
            )}

            {sortedDeviceClasses.length === 0 && !isLoading && (
              <tr>
                <td colSpan={4} className="py-6 px-4 text-center text-slate-400">
                  {tr('deviceClassesPage.noResults', 'No device classes found.')}
                </td>
              </tr>
            )}
          </tbody>
          <AdaptiveTableFillerRows count={rowsPerPage - pagedDeviceClasses.length} columnCount={4} />
        </table>
      </div>

      {sortedDeviceClasses.length > 0 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
          <div className="text-xs text-slate-400">
            {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
              start: (currentPage - 1) * rowsPerPage + 1,
              end: Math.min(currentPage * rowsPerPage, sortedDeviceClasses.length),
              total: sortedDeviceClasses.length,
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
