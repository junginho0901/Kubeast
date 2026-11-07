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

  it('rows per page is the table\'s value: choosing one reads at once, from the first page, with the filter the table shows', () => {
    const shown = { limit: 50, offset: 100, as_of: 310374, action: 'k8s.pod.delete' }
    expect(auditLimitFilter(shown, 25)).toEqual({ limit: 25, offset: 0, action: 'k8s.pod.delete' })
    expect(auditLimitFilter({ limit: 50, offset: 0 }, 200)).toEqual({ limit: 200, offset: 0 })
  })

  it('says when the rows counted are more than one CSV holds, with the numbers of the answer', () => {
    expect(auditExportCut(answer(310374, 310374, 50000))).toEqual({ limit: 50000, total: 310374 })
    expect(auditExportCut(answer(50000, 310374, 50000))).toBeNull()
    expect(auditExportCut(answer(65, 310374, 50000))).toBeNull()
    expect(auditExportCut(answer(310374))).toBeNull()
    expect(auditExportCut(undefined)).toBeNull()
  })
})
