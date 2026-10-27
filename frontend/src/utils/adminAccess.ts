import type { PermissionMatrix } from './permissions'

// The permissions that open each admin page: the key of the API the page cannot render without (the backend checks
// the same key), or any of its action keys where the list itself is public (roles, teams). A role may carry some of
// these without the others (Role Management offers them one by one), so the routes and the sidebar ask per page; the
// global admin's "*" passes all of them.
export const ADMIN_PAGE_PERMISSIONS: Record<string, string[]> = {
  '/setup': ['admin.clusters.create'],
  '/admin/clusters': ['admin.clusters.list'],
  '/admin/users': ['admin.users.read'],
  '/admin/roles': ['admin.roles.create', 'admin.roles.update', 'admin.roles.delete'],
  '/admin/access-requests': ['admin.users.update'],
  '/admin/access-review': ['admin.review.read'],
  '/admin/cluster-hygiene': ['admin.hygiene.read'],
  '/admin/organizations': ['admin.organizations.create', 'admin.organizations.delete'],
  '/admin/ai-models': ['admin.ai_models.*'],
  '/admin/audit': ['admin.audit.read'],
  '/admin/session-recordings': ['admin.sessions.read'],
  '/admin/ai-usage': ['admin.audit.read'],
  '/admin/investigations': ['admin.investigations.read'],
  '/admin/node-shell': ['resource.node.shell'],
}

// Only "*" reaches every cluster: admin.* keys open admin pages, not clusters (auth-service puts the global role's
// "*" and admin.* keys in matrix["*"], and cluster access still needs a grant).
export function isGlobalAdmin(matrix: PermissionMatrix): boolean {
  return (matrix['*'] ?? []).includes('*')
}

// A role's permission list (not a token matrix): the same rule for the person a page shows.
export function roleReachesEveryCluster(permissions: string[] | null | undefined): boolean {
  return (permissions ?? []).includes('*')
}
