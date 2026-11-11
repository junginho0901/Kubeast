import type { AuditLogFilter, AuditLogListResponse } from '@/services/api'
import { serverPageRead } from '@/utils/fitServerPage'

// Another page of the same read: the as_of the first page answered keeps its
// rows, so rows written meanwhile (each read writes one) do not shift them. A
// placeholder answer belongs to the filter before, so its as_of is not taken.
export function auditPageFilter(filter: AuditLogFilter, offset: number, answer?: AuditLogListResponse, placeholder = false): AuditLogFilter {
  return { ...filter, offset, as_of: filter.as_of ?? (placeholder ? undefined : answer?.as_of) }
}

// The read for a rows per page (the screen's Fit or the footer's choice): the page that holds the first row on
// screen, of the same read (as_of), so a new size neither goes back to the first page nor lets rows written since in.
// With Fit the first page is one block cut at the rows that fit (utils/fitServerPage), so opening the log is one read
// and one audit row.
export function auditLimitFilter(filter: AuditLogFilter, limit: number, fit = false): AuditLogFilter {
  return { ...filter, ...serverPageRead(Math.floor((filter.offset ?? 0) / limit) + 1, limit, fit) }
}

// The CSV of the applied filter, of the rows the screen counts (as_of).
export function auditExportHref(filter: AuditLogFilter, asOf?: number): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries({ ...filter, as_of: asOf })) {
    if (k === 'limit' || k === 'offset' || v === undefined || v === '') continue
    params.set(k, String(v))
  }
  return `/api/v1/auth/admin/audit-logs/export?${params.toString()}`
}

// When the rows counted are more than one CSV holds: both numbers from the answer.
export function auditExportCut(answer?: AuditLogListResponse): { limit: number; total: number } | null {
  if (!answer || answer.export_limit === undefined || answer.total <= answer.export_limit) return null
  return { limit: answer.export_limit, total: answer.total }
}
