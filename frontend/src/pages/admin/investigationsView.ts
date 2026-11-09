import type { InvestigationSummary } from '@/services/api/investigations'

// What the Investigations list draws from one answer. While another page, filter or page size
// loads the previous answer stays on screen, so the range, page, rows per page and filter come
// with it rather than from what was just asked.

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

export function investigationsView(data: InvestigationsAnswer | undefined, page: number, pageSize: number) {
  const rows = data?.items ?? []
  const total = data?.total ?? 0
  const shownPage = data?.page ?? page
  const limit = data?.limit ?? pageSize
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
