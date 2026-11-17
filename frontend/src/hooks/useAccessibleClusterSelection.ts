import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'

import { clustersApi, type ClusterMeta } from '@/services/api/clusters'
import { useCluster } from '@/contexts/ClusterContext'

/**
 * The clusters this user can access (the picker's list), with the selection reconciled to them. Besides the initial
 * auto-select, this corrects a selection left over from a previous login: a cluster the current user can't access (or
 * any stale id) must not stay selected, or the axios interceptor keeps sending ?cluster=<it> and the server now 403s
 * every read. Prefer the cluster the initial Setup registers (id "default") over registry order. With no accessible
 * cluster, clear the selection so no ?cluster= is sent at all.
 */
export function useAccessibleClusterSelection(): { clusters: ClusterMeta[]; isLoading: boolean } {
  const { currentCluster, setCurrentCluster } = useCluster()
  const { data: clusters = [], isLoading } = useQuery({
    queryKey: ['clusters-accessible'],
    queryFn: () => clustersApi.listClusters(true),
    staleTime: 30_000,
  })

  useEffect(() => {
    if (isLoading) return
    if (clusters.length === 0) {
      if (currentCluster) setCurrentCluster('')
      return
    }
    const accessible = clusters.some((c) => c.id === currentCluster)
    if (!currentCluster || !accessible) {
      const preferred = clusters.find((c) => c.id === 'default') ?? clusters[0]
      if (preferred.id !== currentCluster) setCurrentCluster(preferred.id)
    }
  }, [currentCluster, clusters, isLoading, setCurrentCluster])

  return { clusters, isLoading }
}
