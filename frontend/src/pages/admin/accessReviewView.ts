import type { AccessReviewReport } from '@/services/api/access_review'

// What the access review page says beside its tables: the page of past sign-offs to read (as many as the table
// fits, or the footer's fixed choice), the API keys tab's count (every key, the expired ones named, unlike the
// "Active API keys" card) and the note when the temporary grants section holds only the newest requests of the
// window.

export const HISTORY_PER_PAGE = 25

export function historyPage(page: number, perPage = HISTORY_PER_PAGE): { limit: number; offset: number } {
  const limit = Math.max(1, Math.floor(perPage))
  return { limit, offset: (Math.max(1, page) - 1) * limit }
}

export function apiKeyTabCount(report: AccessReviewReport): { all: number; expired: number } {
  const keys = report.api_keys ?? []
  return { all: keys.length, expired: keys.filter((k) => k.flags.includes('expired')).length }
}

// null while the section holds every request since the window start (or the report predates the count)
export function requestsCut(report: AccessReviewReport): { shown: number; total: number; since: string } | null {
  const shown = (report.access_requests ?? []).length
  const total = report.access_requests_total
  return typeof total === 'number' && total > shown ? { shown, total, since: report.since } : null
}
