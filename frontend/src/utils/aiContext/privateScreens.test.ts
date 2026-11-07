import { describe, expect, it } from 'vitest'
import { isPrivateScreen } from './privateScreens'
import { resolveRouteMeta } from './routeMatcher'

describe('isPrivateScreen', () => {
  it('keeps the admin pages and the account page private', () => {
    for (const p of ['/admin', '/admin/users', '/admin/audit', '/admin/ai-usage', '/admin/session-recordings', '/account']) {
      expect(isPrivateScreen(p), p).toBe(true)
    }
  })

  it('lets the floating chat read cluster hygiene, alert investigations and every other screen', () => {
    for (const p of ['/cluster/hygiene', '/admin/investigations', '/', '/workloads/pods', '/accounts-report']) {
      expect(isPrivateScreen(p), p).toBe(false)
    }
  })

  it('does not open a path that only starts like a readable one', () => {
    expect(isPrivateScreen('/admin/investigationsx')).toBe(true)
  })

  it('reads the old cluster hygiene address as an admin page, which only redirects', () => {
    expect(isPrivateScreen('/admin/cluster-hygiene')).toBe(true)
  })
})

describe('the screen Cluster Hygiene is', () => {
  it('its address names the page and the sidebar entry', () => {
    expect(resolveRouteMeta('/cluster/hygiene')).toMatchObject({ pageType: 'cluster-hygiene', titleKey: 'nav.clusterHygiene' })
  })
})
