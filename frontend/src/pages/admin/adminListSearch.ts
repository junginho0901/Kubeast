import type { ClusterMeta } from '@/services/api/clusters'
import type { Member, Organization, RoleWithDetails } from '@/services/api'

// The searches of the admin lists that page their rows (Teams, Roles, Clusters, Users and its Pending window): a page
// of them is all the browser's find reaches, so each list has a box whose text names what it reads, and it reads
// those fields of every row, not only the page shown. Empty or spaces only lists every row in the order given.

const words = (search: string) => search.trim().toLowerCase()
const holds = (q: string, fields: (string | null | undefined)[]) => fields.some((f) => (f ?? '').toLowerCase().includes(q))

function matching<T>(rows: readonly T[], search: string, fields: (row: T) => (string | null | undefined)[]): T[] {
  const q = words(search)
  return q ? rows.filter((r) => holds(q, fields(r))) : [...rows]
}

// Teams: by name
export const teamsMatching = (teams: readonly Organization[], search: string) => matching(teams, search, (t) => [t.name])

// Roles: by name, the description its row shows (a system role's in the viewer's language) or any of its permission
// keys, the ones past the five the row shows too
export const rolesMatching = (roles: readonly RoleWithDetails[], search: string, shownDescription: (role: RoleWithDetails) => string) =>
  matching(roles, search, (r) => [r.name, shownDescription(r), ...r.permissions])

// Clusters: by name, the API server its row shows ("In-cluster" for the cluster Kubeast runs in) or who created it
export const clustersMatching = (clusters: readonly ClusterMeta[], search: string, shownApiServer: (cluster: ClusterMeta) => string) =>
  matching(clusters, search, (c) => [c.display_name, shownApiServer(c), c.created_by])

// Users and the Pending window: by name, email or team
export const usersMatching = (users: readonly Member[], search: string) => matching(users, search, (u) => [u.name, u.email, u.team])
