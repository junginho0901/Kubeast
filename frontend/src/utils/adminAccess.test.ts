import { describe, expect, it } from 'vitest'
import { ADMIN_PAGE_PERMISSIONS, isGlobalAdmin, roleReachesEveryCluster } from './adminAccess'
import { hasPermission, type PermissionMatrix } from './permissions'

// The sidebar (Layout canOpen) and the routes (RequireAdmin → RequirePermission) both ask has(p) of the page's keys on
// the selected cluster.
const opens = (matrix: PermissionMatrix, cluster = 'default') =>
  Object.entries(ADMIN_PAGE_PERMISSIONS)
    .filter(([, perms]) => perms.some((p) => hasPermission(matrix, p, cluster)))
    .map(([page]) => page)
    .sort()

describe('admin pages by permission', () => {
  it('a role with the user keys opens User Management and Access Requests, nothing else', () => {
    expect(opens({ '*': ['admin.users.read', 'admin.users.update'] })).toEqual(['/admin/access-requests', '/admin/users'])
  })

  it('an auditor opens the audit log and AI usage', () => {
    expect(opens({ '*': ['admin.audit.read'] })).toEqual(['/admin/ai-usage', '/admin/audit'])
  })

  it('one action key opens the pages whose list is public', () => {
    expect(opens({ '*': ['admin.roles.delete', 'admin.organizations.create'] })).toEqual(['/admin/organizations', '/admin/roles'])
  })

  it('the global admin opens every page, admin.* every admin page', () => {
    expect(opens({ '*': ['*'] })).toEqual(Object.keys(ADMIN_PAGE_PERMISSIONS).sort())
    expect(opens({ '*': ['admin.*'] })).toEqual(Object.keys(ADMIN_PAGE_PERMISSIONS).filter((p) => p !== '/admin/node-shell').sort())
  })

  it('an Admin grant on one cluster opens Node Shell there and no admin page', () => {
    expect(opens({ self: ['*'] }, 'self')).toEqual(['/admin/node-shell'])
    expect(opens({ self: ['*'] }, 'default')).toEqual([])
  })

  it('admin keys in a cluster grant open nothing; the global role keeps its pages beside a cluster Admin grant', () => {
    expect(opens({ default: ['admin.users.read', 'admin.users.update', 'admin.*'] })).toEqual([])
    expect(opens({ '*': ['admin.audit.read'], default: ['*'] })).toEqual(['/admin/ai-usage', '/admin/audit', '/admin/node-shell'])
  })

  it('only "*" reaches every cluster', () => {
    expect(isGlobalAdmin({ '*': ['*'] })).toBe(true)
    expect(isGlobalAdmin({ '*': ['admin.*'] })).toBe(false)
    expect(isGlobalAdmin({ default: ['*'] })).toBe(false)
    expect(roleReachesEveryCluster(['*'])).toBe(true)
    expect(roleReachesEveryCluster(['admin.users.read', 'admin.*'])).toBe(false)
    expect(roleReachesEveryCluster(undefined)).toBe(false)
  })
})
