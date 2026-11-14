import type { InvestigationSummary } from '@/services/api/investigations'
import { answerPageSize } from '@/utils/fitServerPage'

// What the Investigations list draws from one answer. While another page or page size of the same
// filter loads the previous answer stays on screen, so the range, page and rows per page come with
// it rather than from what was just asked.

export interface InvestigationsFilter {
  status: string
  cluster: string
}

export interface InvestigationsAnswer {
  items: InvestigationSummary[]
  total: number
  filter: InvestigationsFilter
  page: number
  // the rows per page this answer was asked with
  limit: number
}

const NO_FILTER: InvestigationsFilter = { status: '', cluster: '' }

// With Fit the first page is read as one block (utils/fitServerPage): it is cut at the rows that fit now.
export function investigationsView(data: InvestigationsAnswer | undefined, page: number, pageSize: number) {
  const total = data?.total ?? 0
  const shownPage = data?.page ?? page
  const limit = data ? answerPageSize({ offset: (data.page - 1) * data.limit, limit: data.limit }, pageSize) : pageSize
  const rows = (data?.items ?? []).slice(0, limit)
  const first = (shownPage - 1) * limit + 1
  const last = first + rows.length - 1
  return {
    rows,
    total,
    shownPage,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
    first,
    last,
    hasNext: last < total,
    shownFilter: data?.filter ?? NO_FILTER,
  }
}
