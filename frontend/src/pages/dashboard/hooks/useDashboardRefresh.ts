// Dashboard "Refresh" button — reads again what the page shows for the
// current cluster. The page's queries carry the cluster as the key's second
// part (['cluster-overview', ck], ['prometheus', ck, …]), so they are marked
// stale by that and the ones on screen are fetched again now; the window
// lists fetch again when opened. Another cluster's data is left alone.
// A failed read of the page's counts (the overview) is said under the header
// (hooks/useRefresh); the cards below say their own.

import { useQueryClient } from '@tanstack/react-query'

import { useCluster } from '@/contexts/ClusterContext'
import { useRefresh } from '@/hooks/useRefresh'

export function useDashboardRefresh() {
  const queryClient = useQueryClient()
  const { currentCluster } = useCluster()
  const ck = currentCluster || 'default'

  const { refresh: handleRefresh, refreshing: isRefreshing, failure: refreshFailure } = useRefresh(async () => {
    await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[1] === ck })
    const overview = queryClient.getQueryState(['cluster-overview', ck])
    if (overview?.status === 'error' && overview.error) throw overview.error
  })

  return { isRefreshing, handleRefresh, refreshFailure }
}
