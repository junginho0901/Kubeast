import { describe, expect, it } from 'vitest'
import type { AccessReviewReport } from '@/services/api/access_review'
import { REQUESTS_PER_PAGE, accessRequestQuery, pageCount } from './accessRequestPages'
import { HISTORY_PER_PAGE, apiKeyTabCount, historyPage, requestsCut } from './accessReviewView'

describe('access request pages', () => {
  it('asks the server for the tab, the search and the page', () => {
    expect(accessRequestQuery('pending', '', 1)).toEqual({ status: 'pending', limit: REQUESTS_PER_PAGE, offset: 0 })
    // History = every request no longer pending, searched and paged by the server
    expect(accessRequestQuery('history', '  Alice ', 3)).toEqual({ status: 'decided', q: 'Alice', limit: 25, offset: 50 })
    expect(accessRequestQuery('history', '', 0).offset).toBe(0)
  })

  it('counts the pages of every match', () => {
    expect([0, 1, 25, 26, 205].map((n) => pageCount(n, 25))).toEqual([1, 1, 1, 2, 9])
  })
})

const report = (over: Partial<AccessReviewReport>): AccessReviewReport => ({
  generated_at: '2026-11-05T03:00:00Z', settings: { dormant_days: 90, interval_days: 90 }, since: '2026-08-07T03:00:00Z',
  last_review: null, next_due_at: null, overdue: false,
  summary: { users: 0, global_admins: 0, dormant: 0, never_logged_in: 0, locked: 0, dormant_locked: 0, cluster_grants: 0, temporary_grants: 0, api_keys_active: 0, api_keys_expiring: 0, api_keys_unused: 0, access_requests: 0 },
  users: [], cluster_roles: [], api_keys: [], access_requests: [], roles: [], ...over,
})
const key = (flags: string[]) => ({ owner_email: 'a@x', name: 'k', key_prefix: 'kbk_', clusters: [], role_ceiling: 'Read', created_at: '', expires_at: '', last_used_at: null, flags })
const request = () => ({ requester_email: 'a@x', cluster: 'c', role: 'Write', duration_minutes: 30, reason: 'r', status: 'rejected', created_at: '' })

describe('access review notes', () => {
  it('pages the past sign-offs', () => {
    expect(historyPage(1)).toEqual({ limit: HISTORY_PER_PAGE, offset: 0 })
    expect(historyPage(18)).toEqual({ limit: 25, offset: 425 })
  })

  it('counts every API key on the tab and names the expired ones', () => {
    expect(apiKeyTabCount(report({ api_keys: [key(['expired']), key([]), key(['expiring_30d']), key(['expired', 'unused_30d'])] }))).toEqual({ all: 4, expired: 2 })
    expect(apiKeyTabCount(report({ api_keys: [key([])] }))).toEqual({ all: 1, expired: 0 })
  })

  it('says when the temporary grants hold only the newest requests of the window', () => {
    const rows = [request(), request()]
    expect(requestsCut(report({ access_requests: rows, access_requests_total: 5001 }))).toEqual({ shown: 2, total: 5001, since: '2026-08-07T03:00:00Z' })
    expect(requestsCut(report({ access_requests: rows, access_requests_total: 2 }))).toBeNull()
    // a sign-off stored before the count
    expect(requestsCut(report({ access_requests: rows }))).toBeNull()
  })
})
