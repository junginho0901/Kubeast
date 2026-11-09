import { describe, expect, it } from 'vitest'

import type { AuditLogListResponse } from '@/services/api'
import { auditExportCut, auditExportHref, auditLimitFilter, auditPageFilter } from './adminAuditPages'

const answer = (total: number, as_of?: number, export_limit?: number): AuditLogListResponse => ({ total, items: [], as_of, export_limit })

describe('audit log pages keep the first read', () => {
  it('the next page carries the as_of the first page answered', () => {
    const filter = { limit: 25, offset: 0, actor_email: 'a@kubeast.local' }
    expect(auditPageFilter(filter, 25, answer(60, 310374))).toEqual({ limit: 25, offset: 25, actor_email: 'a@kubeast.local', as_of: 310374 })
    // a page after that keeps the same as_of, whatever a later answer says
    expect(auditPageFilter({ ...filter, offset: 25, as_of: 310374 }, 50, answer(60, 310399)).as_of).toBe(310374)
  })

  it('an answer still showing the filter before is not taken', () => {
    expect(auditPageFilter({ limit: 25, offset: 0, action: 'k8s.pod.delete' }, 25, answer(60, 310374), true).as_of).toBeUndefined()
  })
})

describe('audit log CSV', () => {
  it('asks for the rows the screen counts: the filter and its as_of, not the page', () => {
    const href = auditExportHref({ limit: 25, offset: 50, action: 'admin.audit.read', until: '2026-11-05T01:30:59.999999Z', as_of: 1 }, 310374)
    const url = new URL(href, 'http://x')
    expect(url.pathname).toBe('/api/v1/auth/admin/audit-logs/export')
    expect(Object.fromEntries(url.searchParams)).toEqual({ action: 'admin.audit.read', until: '2026-11-05T01:30:59.999999Z', as_of: '310374' })
  })

  it('a new rows per page (the screen\'s height or a choice) shows the page holding the first row on screen, of the same read', () => {
    // rows 101-150 on screen: 25 a page shows rows 101-125, the same as_of
    expect(auditLimitFilter({ limit: 50, offset: 100, as_of: 310374, action: 'k8s.pod.delete' }, 25)).toEqual({ limit: 25, offset: 100, as_of: 310374, action: 'k8s.pod.delete' })
    // rows 76-100 on screen: 50 a page shows rows 51-100, which hold them
    expect(auditLimitFilter({ limit: 25, offset: 75, as_of: 310374 }, 50)).toEqual({ limit: 50, offset: 50, as_of: 310374 })
    // rows 23-33 on screen (Fit, 11 rows): 14 a page shows rows 15-28
    expect(auditLimitFilter({ limit: 11, offset: 22 }, 14)).toEqual({ limit: 14, offset: 14 })
    expect(auditLimitFilter({ offset: 0 }, 12)).toEqual({ limit: 12, offset: 0 })
  })

  it('says when the rows counted are more than one CSV holds, with the numbers of the answer', () => {
    expect(auditExportCut(answer(310374, 310374, 50000))).toEqual({ limit: 50000, total: 310374 })
    expect(auditExportCut(answer(50000, 310374, 50000))).toBeNull()
    expect(auditExportCut(answer(65, 310374, 50000))).toBeNull()
    expect(auditExportCut(answer(310374))).toBeNull()
    expect(auditExportCut(undefined)).toBeNull()
  })
})
