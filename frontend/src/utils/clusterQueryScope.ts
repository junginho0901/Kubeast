import { notifyManager, type QueryClient } from '@tanstack/react-query'

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
  // the registry as the person may reach it (/clusters answers the same whatever cluster is selected), which the
  // screens' gate waits on (ClusterGate): emptied without asking, the screens would wait with nothing asking it again.
  // A switch reads it again behind its answer (REGISTRY_KEYS).
  'clusters-accessible',
  'clusters-all',
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

// The cluster registry's keys, kept on a switch but read again.
const REGISTRY_KEYS = new Set<string>(['clusters-accessible', 'clusters-all'])

// dropClusterQueries empties the cluster-scoped cache when the selected cluster
// changes and asks for none of it: a query of the screen being left, asked then,
// would go out as the new cluster with that screen's key and parameters, beside
// the one the new screen asks for. A fetch on its way stops.
export function dropClusterQueries(queryClient: QueryClient): void {
  notifyManager.batch(() => {
    for (const query of queryClient.getQueryCache().findAll({ predicate: (q) => isClusterScopedQueryKey(q.queryKey) })) {
      query.reset()
    }
  })
  // the registry keeps its answer and is read again on screen, so a switch shows the clusters' health as it is now
  void queryClient.invalidateQueries({ predicate: (q) => REGISTRY_KEYS.has(String(q.queryKey[0])) })
}

// askClusterQueriesOnScreen runs once the new cluster is drawn: a cluster-scoped
// query still on screen with no answer and nothing on its way asks — one whose
// component did not render again under a key that names no cluster, or whose
// fetch the switch stopped. A query that started again under the new cluster has
// asked by itself, and those of the screen left have gone with it.
export function askClusterQueriesOnScreen(queryClient: QueryClient): Promise<void> {
  return queryClient.refetchQueries(
    {
      type: 'active',
      predicate: (q) => isClusterScopedQueryKey(q.queryKey) && q.state.data === undefined && q.state.fetchStatus === 'idle',
    },
    { cancelRefetch: false },
  )
}
