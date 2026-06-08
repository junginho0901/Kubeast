// Which TanStack Query keys are scoped to a specific cluster (step 10).
//
// When the selected cluster changes we drop the cluster-scoped cache so the new
// cluster's data is fetched fresh and nothing bleeds across clusters. Keys that
// are cluster-independent (identity, roles, the cluster registry itself, setup,
// chat sessions, admin metadata) are KEPT so a switch doesn't needlessly refetch
// them or flicker the picker / auth state.

// Top-level query-key segments that are NOT tied to a cluster.
const CLUSTER_INDEPENDENT_KEYS = new Set<string>([
  'me',
  'roles',
  'permissions',
  'organizations',
  'admin-users',
  'sessions',
  'session',
  'clusters',
  'cluster-roles',
  'setup',
  'setup-status',
  'deployment-mode',
  'ai-models',
  'audit-logs',
])

// isClusterScopedQueryKey reports whether a query's cache should be dropped on a
// cluster switch. Decided by the first key segment; non-array / non-string heads
// are treated as NOT cluster-scoped (kept) to avoid clearing anything unexpected.
export function isClusterScopedQueryKey(queryKey: unknown): boolean {
  if (!Array.isArray(queryKey) || queryKey.length === 0) return false
  const head = queryKey[0]
  if (typeof head !== 'string') return false
  return !CLUSTER_INDEPENDENT_KEYS.has(head)
}
