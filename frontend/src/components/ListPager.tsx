import { useTranslation } from 'react-i18next'
import { PageSizeSelect } from '@/components/PageSizeSelect'

interface Props {
  currentPage: number
  totalPages: number
  /** Rows after search and filters */
  total: number
  rowsPerPage: number
  onPageChange: (page: number) => void
  /** Off for tables with a fixed page size (admin pages that scroll with the page) */
  showPageSize?: boolean
  testId?: string
}

const pagerButton =
  'px-3 py-1.5 text-xs rounded-sm border border-slate-600 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:text-white hover:border-slate-500'

// The footer of every list table: rows per page, the range shown and the page buttons — always there, also with
// one page or no rows, so a list never changes shape with its row count.
export function ListPager({ currentPage, totalPages, total, rowsPerPage, onPageChange, showPageSize = true, testId = 'list-pager' }: Props) {
  const { t } = useTranslation()
  const pages = Math.max(1, totalPages)
  return (
    <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0" data-testid={testId}>
      <div className="flex items-center gap-4 text-xs text-slate-400">
        {showPageSize && <PageSizeSelect />}
        {total === 0
          ? t('common.paginationEmpty', 'Showing 0 of 0')
          : t('common.paginationRange', {
              start: (currentPage - 1) * rowsPerPage + 1,
              end: Math.min(currentPage * rowsPerPage, total),
              total,
              defaultValue: 'Showing {{start}}-{{end}} of {{total}}',
            })}
      </div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => onPageChange(Math.max(1, currentPage - 1))} disabled={currentPage <= 1} className={pagerButton}>
          {t('common.prev', 'Prev')}
        </button>
        <span className="text-xs text-slate-300 min-w-[72px] text-center">
          {Math.min(currentPage, pages)} / {pages}
        </span>
        <button type="button" onClick={() => onPageChange(Math.min(pages, currentPage + 1))} disabled={currentPage >= pages} className={pagerButton}>
          {t('common.next', 'Next')}
        </button>
      </div>
    </div>
  )
}
