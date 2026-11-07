import { describe, expect, it } from 'vitest'
import { ADMIN_PAGE_PERMISSIONS, isGlobalAdmin, readsHygiene, roleReachesEveryCluster } from './adminAccess'
import { hasPermission, type PermissionMatrix } from './permissions'

// The sidebar (Layout canOpen) and the routes (RequireAdmin → RequirePermission) both ask has(p) of the page's keys on
// the selected cluster.
const opens = (matrix: PermissionMatrix, cluster = 'default') =>
  Object.entries(ADMIN_PAGE_PERMISSIONS)
    .filter(([, perms]) => perms.some((p) => hasPermission(matrix, p, cluster)))
    .map(([page]) => page)
    .sort()

// The seeded roles (auth-service repository_schema.go SeedSystemRoles): their wildcards are what a key must stay out of.
const READ = ['menu.cluster', 'resource.*.read', 'resource.helm.read', 'resource.pod.logfile', 'ai.mcp.use']
const WRITE = ['menu.*', 'resource.*.read', 'resource.*.create', 'resource.*.edit', 'resource.*.delete', 'resource.secret.reveal', 'ai.tool.*', 'ai.mcp.use']

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

  it('the global admin opens every page, admin.* every page too', () => {
    expect(opens({ '*': ['*'] })).toEqual(Object.keys(ADMIN_PAGE_PERMISSIONS).sort())
    expect(opens({ '*': ['admin.*'] })).toEqual(Object.keys(ADMIN_PAGE_PERMISSIONS).sort())
  })

  it('an Admin grant on one cluster opens Cluster Hygiene there and no admin page', () => {
    expect(opens({ self: ['*'] }, 'self')).toEqual(['/cluster/hygiene'])
    expect(opens({ self: ['*'] }, 'default')).toEqual([])
  })

  it('the Read and Write roles do not open Cluster Hygiene', () => {
    expect(opens({ self: READ }, 'self')).toEqual([])
    expect(opens({ self: WRITE }, 'self')).toEqual([])
  })

  it('the global hygiene key keeps Cluster Hygiene open on any cluster', () => {
    expect(opens({ '*': ['admin.hygiene.read'] }, 'self')).toEqual(['/cluster/hygiene'])
    expect(opens({ '*': ['admin.hygiene.read'] }, 'other')).toEqual(['/cluster/hygiene'])
  })

  it('admin keys in a cluster grant open nothing; the global role keeps its pages beside a cluster Admin grant', () => {
    expect(opens({ default: ['admin.users.read', 'admin.users.update', 'admin.*'] })).toEqual([])
    expect(opens({ '*': ['admin.audit.read'], default: ['*'] })).toEqual(['/admin/ai-usage', '/admin/audit', '/cluster/hygiene'])
  })

  it('Node Shell is no admin page any more', () => {
    expect(Object.keys(ADMIN_PAGE_PERMISSIONS)).not.toContain('/admin/node-shell')
    expect(Object.keys(ADMIN_PAGE_PERMISSIONS)).not.toContain('/admin/cluster-hygiene')
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

describe('who reads a cluster\'s hygiene report', () => {
  const has = (matrix: PermissionMatrix) => (perm: string, cluster?: string) => hasPermission(matrix, perm, cluster ?? 'self')

  it('an Admin grant over the whole cluster', () => {
    expect(readsHygiene(has({ self: ['*'] }), null)).toBe(true)
    expect(readsHygiene(has({ self: ['*'] }), [])).toBe(true)
  })

  it('not an Admin grant limited to namespaces: the report spans the cluster and the server refuses it', () => {
    expect(readsHygiene(has({ self: ['*'] }), ['team-a'])).toBe(false)
  })

  it('the global key, on any cluster', () => {
    expect(readsHygiene(has({ '*': ['admin.hygiene.read'] }), null)).toBe(true)
    expect(readsHygiene(has({ '*': ['admin.hygiene.read'] }), ['team-a'])).toBe(true)
  })

  it('not the Read and Write roles', () => {
    expect(readsHygiene(has({ self: READ }), null)).toBe(false)
    expect(readsHygiene(has({ self: WRITE }), null)).toBe(false)
  })

  it('asks about the cluster it is told', () => {
    expect(readsHygiene(has({ self: ['*'] }), null, 'other')).toBe(false)
    expect(readsHygiene(has({ self: ['*'], other: READ }), null, 'other')).toBe(false)
    expect(readsHygiene(has({ self: READ, other: ['*'] }), null, 'other')).toBe(true)
  })
})
