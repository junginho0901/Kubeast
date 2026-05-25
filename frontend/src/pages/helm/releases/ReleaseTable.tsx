import { RefObject } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, ExternalLink, Package } from 'lucide-react'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import type { HelmReleaseSummary } from '@/services/api'
import {
  formatUpdated,
  statusBadge,
  HELM_DOCS_URL,
  HELM_INSTALL_GUIDE_URL,
  type SortKey,
  type SortDir,
} from './releaseHelpers'

interface Props {
  paged: HelmReleaseSummary[]
  sortedCount: number
  sortKey: SortKey
  sortDir: SortDir
  onSort: (key: NonNullable<SortKey>) => void
  currentPage: number
  totalPages: number
  rowsPerPage: number
  onPageChange: (page: number) => void
  tableContainerRef: RefObject<HTMLDivElement>
  tableBodyRef: RefObject<HTMLDivElement>
  theadRef: RefObject<HTMLTableSectionElement>
  firstRowRef: RefObject<HTMLTableRowElement>
}

export default function ReleaseTable({
  paged,
  sortedCount,
  sortKey,
  sortDir,
  onSort,
  currentPage,
  totalPages,
  rowsPerPage,
  onPageChange,
  tableContainerRef,
  tableBodyRef,
  theadRef,
  firstRowRef,
}: Props) {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const renderSortIcon = (key: NonNullable<SortKey>) => {
    if (sortKey !== key) return null
    return sortDir === 'asc'
      ? <ChevronUp className="w-3.5 h-3.5 text-slate-300" />
      : <ChevronDown className="w-3.5 h-3.5 text-slate-300" />
  }

  if (sortedCount === 0) {
    return (
      <div className="flex-1 min-h-0 flex items-start">
        <EmptyState />
      </div>
    )
  }

  return (
    <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
      <div ref={tableBodyRef} className="overflow-x-auto flex-1 min-h-0">
        <table className="w-full text-sm table-fixed">
          <thead ref={theadRef} className="text-slate-400">
            <tr>
              <th className="text-left py-3 px-4 w-[200px] cursor-pointer" onClick={() => onSort('name')}>
                <span className="inline-flex items-center gap-1">
                  {t('helmReleases.table.name')}{renderSortIcon('name')}
                </span>
              </th>
              <th className="text-left py-3 px-4 w-[140px] cursor-pointer" onClick={() => onSort('namespace')}>
                <span className="inline-flex items-center gap-1">
                  {t('helmReleases.table.namespace')}{renderSortIcon('namespace')}
                </span>
              </th>
              <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => onSort('revision')}>
                <span className="inline-flex items-center gap-1">
                  {t('helmReleases.table.revision')}{renderSortIcon('revision')}
                </span>
              </th>
              <th className="text-left py-3 px-4 w-[130px] cursor-pointer" onClick={() => onSort('status')}>
                <span className="inline-flex items-center gap-1">
                  {t('helmReleases.table.status')}{renderSortIcon('status')}
                </span>
              </th>
              <th className="text-left py-3 px-4 w-[180px] cursor-pointer" onClick={() => onSort('chart')}>
                <span className="inline-flex items-center gap-1">
                  {t('helmReleases.table.chart')}{renderSortIcon('chart')}
                </span>
              </th>
              <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => onSort('chartVersion')}>
                <span className="inline-flex items-center gap-1">
                  {t('helmReleases.table.chartVersion')}{renderSortIcon('chartVersion')}
                </span>
              </th>
              <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => onSort('appVersion')}>
                <span className="inline-flex items-center gap-1">
                  {t('helmReleases.table.appVersion')}{renderSortIcon('appVersion')}
                </span>
              </th>
              <th className="text-left py-3 px-4 w-[180px] cursor-pointer" onClick={() => onSort('updated')}>
                <span className="inline-flex items-center gap-1">
                  {t('helmReleases.table.updated')}{renderSortIcon('updated')}
                </span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {paged.map((r, idx) => {
              const to = `/helm/releases/${encodeURIComponent(r.namespace)}/${encodeURIComponent(r.name)}`
              return (
                <tr
                  key={`${r.namespace}/${r.name}`}
                  ref={idx === 0 ? firstRowRef : undefined}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => navigate(to)}
                >
                  <td className="py-3 px-4 font-medium text-white">
                    {/* Link kept for cmd/middle-click new-tab;
                        stopPropagation so the row onClick does not
                        double-fire. */}
                    <Link to={to} className="hover:text-primary-400" onClick={(e) => e.stopPropagation()}>
                      <span className="block truncate">{r.name}</span>
                    </Link>
                  </td>
                  <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{r.namespace}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{r.revision}</td>
                  <td className="py-3 px-4">
                    <span
                      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${statusBadge(r.status)}`}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-xs"><span className="block truncate">{r.chart || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{r.chartVersion || '-'}</td>
                  <td className="py-3 px-4 text-xs font-mono">{r.appVersion || '-'}</td>
                  <td className="py-3 px-4 text-xs font-mono text-slate-400">{formatUpdated(r.updated)}</td>
                </tr>
              )
            })}
          </tbody>
          <AdaptiveTableFillerRows count={rowsPerPage - paged.length} columnCount={8} />
        </table>
      </div>
      <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
        <div className="text-xs text-slate-400">
          {t('common.paginationRange', {
            start: (currentPage - 1) * rowsPerPage + 1,
            end: Math.min(currentPage * rowsPerPage, sortedCount),
            total: sortedCount,
            defaultValue: 'Showing {{start}}-{{end}} of {{total}}',
          })}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onPageChange(Math.max(1, currentPage - 1))}
            disabled={currentPage <= 1}
            className="px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:text-white hover:border-slate-500"
          >
            {t('common.prev', { defaultValue: 'Prev' })}
          </button>
          <span className="text-xs text-slate-300 min-w-[72px] text-center">
            {currentPage} / {totalPages}
          </span>
          <button
            type="button"
            onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
            disabled={currentPage >= totalPages}
            className="px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:text-white hover:border-slate-500"
          >
            {t('common.next', { defaultValue: 'Next' })}
          </button>
        </div>
      </div>
    </div>
  )
}

function EmptyState() {
  const { t } = useTranslation()
  return (
    <div className="w-full flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-slate-700 bg-slate-800/20 py-16 text-center">
      <Package className="w-10 h-10 text-slate-500" />
      <div className="text-lg font-semibold text-white">{t('helmReleases.empty.title')}</div>
      <div className="max-w-md text-sm text-slate-400">
        {t('helmReleases.empty.description')}
      </div>
      <div className="flex gap-2 mt-2">
        <a
          href={HELM_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded border border-slate-600 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-700"
        >
          {t('helmReleases.empty.docs')}
          <ExternalLink className="w-3 h-3" />
        </a>
        <a
          href={HELM_INSTALL_GUIDE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded border border-slate-600 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-700"
        >
          {t('helmReleases.empty.installGuide')}
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>
    </div>
  )
}
