import { RefObject } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, ExternalLink, Package } from 'lucide-react'
import { utcTitle } from '@/utils/time'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { ListPager } from '@/components/ListPager'
import type { HelmReleaseSummary } from '@/services/api'
import {
  formatUpdated,
  statusBadge,
  HELM_DOCS_URL,
  HELM_INSTALL_GUIDE_URL,
  type SortKey,
  type SortDir,
} from './releaseHelpers'
import { SortButton } from '@/components/SortButton'
import { sortHeaderProps } from '@/components/sortHeaderProps'

interface Props {
  paged: HelmReleaseSummary[]
  sortedCount: number
  // the search box holds text and the cluster has releases: none matching is not none installed
  searching?: boolean
  sortKey: SortKey
  sortDir: SortDir
  onSort: (key: NonNullable<SortKey>) => void
  currentPage: number
  totalPages: number
  rowsPerPage: number
  onPageChange: (page: number) => void
  tableContainerRef: RefObject<HTMLDivElement | null>
  tableBodyRef: RefObject<HTMLDivElement | null>
  theadRef: RefObject<HTMLTableSectionElement | null>
  firstRowRef: RefObject<HTMLTableRowElement | null>
}

export default function ReleaseTable({
  searching = false,
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

  const sortHead = sortHeaderProps(sortKey, sortDir, onSort)
  const renderSortIcon = (key: NonNullable<SortKey>) => {
    if (sortKey !== key) return null
    return sortDir === 'asc'
      ? <ChevronUp className="w-3.5 h-3.5 text-slate-300" />
      : <ChevronDown className="w-3.5 h-3.5 text-slate-300" />
  }

  if (sortedCount === 0) {
    return (
      <div className="flex-1 min-h-0 flex items-start">
        {searching
          ? <p className="w-full py-16 text-center text-sm text-slate-400" data-testid="helm-no-search-results">{t('common.noSearchResults', { defaultValue: 'No results found.' })}</p>
          : <EmptyState />}
      </div>
    )
  }

  return (
    <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
      <div ref={tableBodyRef} className="overflow-x-auto flex-1 min-h-0">
        <table className="w-full text-sm table-fixed">
          <thead ref={theadRef} className="text-slate-400">
            <tr>
              <th className="col-low text-left py-3 px-4 w-[140px] cursor-pointer" {...sortHead('namespace')}>
                <SortButton>
                  {t('helmReleases.table.namespace')}{renderSortIcon('namespace')}
                </SortButton>
              </th>
              <th className="text-left py-3 px-4 w-[200px] cursor-pointer" {...sortHead('name')}>
                <SortButton>
                  {t('helmReleases.table.name')}{renderSortIcon('name')}
                </SortButton>
              </th>
              <th className="text-left py-3 px-4 w-[90px] cursor-pointer" {...sortHead('revision')}>
                <SortButton>
                  {t('helmReleases.table.revision')}{renderSortIcon('revision')}
                </SortButton>
              </th>
              <th className="text-left py-3 px-4 w-[130px] cursor-pointer" {...sortHead('status')}>
                <SortButton>
                  {t('helmReleases.table.status')}{renderSortIcon('status')}
                </SortButton>
              </th>
              <th className="text-left py-3 px-4 w-[180px] cursor-pointer" {...sortHead('chart')}>
                <SortButton>
                  {t('helmReleases.table.chart')}{renderSortIcon('chart')}
                </SortButton>
              </th>
              <th className="text-left py-3 px-4 w-[120px] cursor-pointer" {...sortHead('chartVersion')}>
                <SortButton>
                  {t('helmReleases.table.chartVersion')}{renderSortIcon('chartVersion')}
                </SortButton>
              </th>
              <th className="col-optional text-left py-3 px-4 w-[120px] cursor-pointer" {...sortHead('appVersion')}>
                <SortButton>
                  {t('helmReleases.table.appVersion')}{renderSortIcon('appVersion')}
                </SortButton>
              </th>
              <th className="col-low text-left py-3 px-4 w-[180px] cursor-pointer" {...sortHead('updated')}>
                <SortButton>
                  {t('helmReleases.table.updated')}{renderSortIcon('updated')}
                </SortButton>
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
                  <td className="col-low py-3 px-4 text-xs font-mono" title={r.namespace}>{r.namespace}</td>
                  <td className="py-3 px-4 font-medium text-ink">
                    {/* Link kept for cmd/middle-click new-tab;
                        stopPropagation so the row onClick does not
                        double-fire. */}
                    <Link to={to} className="hover:text-primary-400" onClick={(e) => e.stopPropagation()}>
                      <span className="block truncate">{r.name}</span>
                    </Link>
                  </td>
                  <td className="py-3 px-4 text-xs font-mono">{r.revision}</td>
                  <td className="py-3 px-4">
                    <span
                      className={`badge ${statusBadge(r.status)}`}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-xs"><span className="block truncate">{r.chart || '-'}</span></td>
                  <td className="py-3 px-4 text-xs font-mono">{r.chartVersion || '-'}</td>
                  <td className="col-optional py-3 px-4 text-xs font-mono">{r.appVersion || '-'}</td>
                  <td className="col-low py-3 px-4 text-xs font-mono text-slate-400" title={utcTitle(r.updated)}>{formatUpdated(r.updated)}</td>
                </tr>
              )
            })}
          </tbody>
          <AdaptiveTableFillerRows count={rowsPerPage - paged.length} columnCount={8} />
        </table>
      </div>
      <ListPager currentPage={currentPage} totalPages={totalPages} total={sortedCount} rowsPerPage={rowsPerPage} onPageChange={onPageChange} />
    </div>
  )
}

function EmptyState() {
  const { t } = useTranslation()
  return (
    <div className="w-full flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-hairline bg-slate-800/20 px-5 py-16 text-center">
      <Package className="w-10 h-10 text-slate-500" />
      <div className="text-lg font-semibold text-ink">{t('helmReleases.empty.title')}</div>
      <div className="max-w-md text-sm text-slate-400">
        {t('helmReleases.empty.description')}
      </div>
      <div className="flex flex-wrap justify-center gap-2 mt-2">
        <a
          href={HELM_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-secondary h-9 inline-flex items-center gap-1.5 text-sm"
        >
          {t('helmReleases.empty.docs')}
          <ExternalLink className="w-3 h-3" />
        </a>
        <a
          href={HELM_INSTALL_GUIDE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-secondary h-9 inline-flex items-center gap-1.5 text-sm"
        >
          {t('helmReleases.empty.installGuide')}
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>
    </div>
  )
}
