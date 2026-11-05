import type { InvestigationSummary } from '@/services/api/investigations'

// What the Investigations list draws from one answer. While another page or filter
// loads the previous answer stays on screen, so the range, page and filter come with
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
}

const NO_FILTER: InvestigationsFilter = { status: '', cluster: '' }

export function investigationsView(data: InvestigationsAnswer | undefined, page: number, pageSize: number) {
  const rows = data?.items ?? []
  const total = data?.total ?? 0
  const shownPage = data?.page ?? page
  const first = (shownPage - 1) * pageSize + 1
  const last = first + rows.length - 1
  return {
    rows,
    total,
    shownPage,
    first,
    last,
    hasNext: last < total,
    shownFilter: data?.filter ?? NO_FILTER,
  }
}
