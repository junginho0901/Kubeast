import { describe, expect, it } from 'vitest'
import { isPrivateScreen } from './privateScreens'

describe('isPrivateScreen', () => {
  it('keeps the admin pages and the account page private', () => {
    for (const p of ['/admin', '/admin/users', '/admin/audit', '/admin/ai-usage', '/admin/session-recordings', '/account']) {
      expect(isPrivateScreen(p), p).toBe(true)
    }
  })

  it('lets the floating chat read cluster hygiene, alert investigations and every other screen', () => {
    for (const p of ['/admin/cluster-hygiene', '/admin/investigations', '/', '/workloads/pods', '/accounts-report']) {
      expect(isPrivateScreen(p), p).toBe(false)
    }
  })

  it('does not open a path that only starts like a readable one', () => {
    expect(isPrivateScreen('/admin/cluster-hygiene-export')).toBe(true)
    expect(isPrivateScreen('/admin/investigationsx')).toBe(true)
  })
})
