import type { AccessRequestQuery } from '@/services/api/access_requests'

// The admin access request pages: the server keeps the history (every request no longer pending), searches it and
// counts it, so a page of the table is a page of the server's answer — as many rows as the table fits, or the
// footer's fixed choice — and its total is every match.

export const REQUESTS_PER_PAGE = 25

export type AccessRequestTab = 'pending' | 'history'

export function accessRequestQuery(tab: AccessRequestTab, search: string, page: number, perPage = REQUESTS_PER_PAGE): AccessRequestQuery {
  const q = search.trim()
  const limit = Math.max(1, Math.floor(perPage))
  return {
    status: tab === 'pending' ? 'pending' : 'decided',
    ...(q ? { q } : {}),
    limit,
    offset: (Math.max(1, page) - 1) * limit,
  }
}

export function pageCount(total: number, perPage: number): number {
  return Math.max(1, Math.ceil(total / perPage))
}
