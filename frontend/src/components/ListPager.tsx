import { useTranslation } from 'react-i18next'
import { PageSizeSelect } from '@/components/PageSizeSelect'

interface Props {
  currentPage: number
  totalPages: number
  /** Rows after search and filters */
  total: number
  /** False while the list has no answer to count (its first read, another namespace's or cluster's): no 0 it did not count */
  counted?: boolean
  rowsPerPage: number
  onPageChange: (page: number) => void
  /** Off for a fixed page size: a section of a page that scrolls by design (the GPU overview, chart panels) or a window's list */
  showPageSize?: boolean
  /**
   * The footer ends a page across its width (a list page, or the list a page scrolls to the end of), where the floating
   * chat button rests on its right: its page buttons keep clear of it (index.css). A section or a window's list does not.
   */
  endsPage?: boolean
  testId?: string
}

const pagerButton =
  'px-3 py-1.5 text-xs rounded-lg border border-control text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-700 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-400'

// The footer of every list table: rows per page, the range shown and the page buttons — always there, also with
// one page or no rows, so a list never changes shape with its row count.
export function ListPager({ currentPage, totalPages, total, counted = true, rowsPerPage, onPageChange, showPageSize = true, endsPage = showPageSize, testId = 'list-pager' }: Props) {
  const { t } = useTranslation()
  const pages = Math.max(1, totalPages)
  return (
    // wraps on a narrow screen (the rows-per-page choice, the range and the buttons do not fit 600 px in one row)
    // instead of widening the page
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 border-t border-hairline shrink-0" data-testid={testId} data-rows-per-page={rowsPerPage}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-400">
        {showPageSize && <PageSizeSelect />}
        {!counted
          ? t('common.paginationNotCounted', 'Showing - of -')
          : total === 0
          ? t('common.paginationEmpty', 'Showing 0 of 0')
          : t('common.paginationRange', {
              start: (currentPage - 1) * rowsPerPage + 1,
              end: Math.min(currentPage * rowsPerPage, total),
              total,
              defaultValue: 'Showing {{start}}-{{end}} of {{total}}',
            })}
      </div>
      {/* list-pager-pages: a footer that ends a page, kept clear of the floating chat button (index.css) */}
      <div className={`${endsPage ? 'list-pager-pages ' : ''}flex items-center gap-2`}>
        <button type="button" onClick={() => onPageChange(Math.max(1, currentPage - 1))} disabled={currentPage <= 1} className={pagerButton}>
          {t('common.prev', 'Prev')}
        </button>
        <span className="text-xs text-slate-300 min-w-[56px] text-center tabular-nums whitespace-nowrap">
          {Math.min(currentPage, pages)} / {pages}
        </span>
        <button type="button" onClick={() => onPageChange(Math.min(pages, currentPage + 1))} disabled={currentPage >= pages} className={pagerButton}>
          {t('common.next', 'Next')}
        </button>
      </div>
    </div>
  )
}
