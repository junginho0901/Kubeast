// Dashboard "Refresh" button — reads again what the page shows for the
// current cluster. The page's queries carry the cluster as the key's second
// part (['cluster-overview', ck], ['prometheus', ck, …]), so they are marked
// stale by that and the ones on screen are fetched again now; the window
// lists fetch again when opened. Another cluster's data is left alone.

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { useCluster } from '@/contexts/ClusterContext'

export function useDashboardRefresh() {
  const [isRefreshing, setIsRefreshing] = useState(false)
  const queryClient = useQueryClient()
  const { currentCluster } = useCluster()
  const ck = currentCluster || 'default'

  const handleRefresh = async () => {
    setIsRefreshing(true)
    try {
      await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[1] === ck })
    } finally {
      setIsRefreshing(false)
    }
  }

  return { isRefreshing, handleRefresh }
}
