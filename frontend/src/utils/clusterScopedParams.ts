// Query parameters that name an object of one cluster — Cluster View's node view: ?node=, ?nodePage=, ?pod= — which a
// switch to another cluster leaves out, so the new cluster's screen never opens the old cluster's node as its own. The
// first selection after sign-in ('' → a cluster) is not a switch: a link's node view stays.
export const CLUSTER_SCOPED_PARAMS = ['node', 'nodePage', 'pod']

// The address's parameters with `id` chosen while `current` is shown.
export function paramsForCluster(prev: URLSearchParams, id: string, current: string): URLSearchParams {
  const next = new URLSearchParams(prev)
  if (id) next.set('cluster', id)
  else next.delete('cluster')
  if (current && id !== current) for (const key of CLUSTER_SCOPED_PARAMS) next.delete(key)
  return next
}
