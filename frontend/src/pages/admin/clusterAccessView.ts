import type { ClusterUserRole } from '@/services/api/admin'

// The grants the Cluster access window lists: every one while its search is empty, else those whose name or email
// holds the words searched — over every grant, not only the page shown.

export function grantsMatching(grants: readonly ClusterUserRole[], search: string): ClusterUserRole[] {
  const q = search.trim().toLowerCase()
  if (!q) return [...grants]
  return grants.filter((g) => `${g.name ?? ''} ${g.email ?? ''}`.toLowerCase().includes(q))
}
