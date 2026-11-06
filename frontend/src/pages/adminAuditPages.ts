import type { AuditLogFilter, AuditLogListResponse } from '@/services/api'

// Another page of the same read: the as_of the first page answered keeps its
// rows, so rows written meanwhile (each read writes one) do not shift them. A
// placeholder answer belongs to the filter before, so its as_of is not taken.
export function auditPageFilter(filter: AuditLogFilter, offset: number, answer?: AuditLogListResponse, placeholder = false): AuditLogFilter {
  return { ...filter, offset, as_of: filter.as_of ?? (placeholder ? undefined : answer?.as_of) }
}

// Rows per page is the table's own value, so choosing one reads at once: the filter the table shows, from the first
// page, and a new as_of (the rows written since show, as a Search would).
export function auditLimitFilter(filter: AuditLogFilter, limit: number): AuditLogFilter {
  const { as_of: _asOf, ...rest } = filter
  return { ...rest, limit, offset: 0 }
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
