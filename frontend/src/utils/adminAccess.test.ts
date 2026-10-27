import { describe, expect, it } from 'vitest'
import { ADMIN_PAGE_PERMISSIONS, isGlobalAdmin, roleReachesEveryCluster } from './adminAccess'
import { hasPermission, type PermissionMatrix } from './permissions'

const opens = (matrix: PermissionMatrix) =>
  Object.entries(ADMIN_PAGE_PERMISSIONS)
    .filter(([, perms]) => perms.some((p) => hasPermission(matrix, p, 'default')))
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

  it('only "*" reaches every cluster', () => {
    expect(isGlobalAdmin({ '*': ['*'] })).toBe(true)
    expect(isGlobalAdmin({ '*': ['admin.*'] })).toBe(false)
    expect(isGlobalAdmin({ default: ['*'] })).toBe(false)
    expect(roleReachesEveryCluster(['*'])).toBe(true)
    expect(roleReachesEveryCluster(['admin.users.read', 'admin.*'])).toBe(false)
    expect(roleReachesEveryCluster(undefined)).toBe(false)
  })
})
