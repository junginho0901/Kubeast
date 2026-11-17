import { useEffect } from 'react'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import { clustersApi, type ClusterMeta } from '@/services/api/clusters'
import { useCluster } from '@/contexts/ClusterContext'
import { retryAsAsked, retryAsAskedDelay } from '@/services/queryDefaults'

/**
 * The clusters this user can access (/clusters?accessibleOnly, the same whatever cluster is selected). A cluster switch
 * keeps it (clusterQueryScope): the screens' gate waits on it. A failure with Retry-After is asked again as told.
 */
export function useClusterList(): UseQueryResult<ClusterMeta[]> {
  return useQuery<ClusterMeta[], Error>({
    queryKey: ['clusters-accessible'],
    queryFn: () => clustersApi.listClusters(true),
    staleTime: 30_000,
    retry: retryAsAsked(1),
    retryDelay: retryAsAskedDelay,
  })
}

type ListRead = Pick<UseQueryResult<ClusterMeta[]>, 'data' | 'isError' | 'failureCount'>

/**
 * Whether the screens may read the selected cluster. With the list answered: the selection is one of its clusters,
 * or it lists none. With no answer yet: a selection there is (stored, or in the address) once the list has failed,
 * while it is asked again too; with none, only once the list has failed for good, when the screens read the server's
 * default cluster as they did before.
 */
export function selectionSettled(list: ListRead, currentCluster: string): boolean {
  if (list.data) return list.data.length === 0 || list.data.some((c) => c.id === currentCluster)
  return currentCluster ? list.isError || list.failureCount > 0 : list.isError
}

/** selectionSettled for the screens: the gate (ClusterGate), the detail drawer and the cluster's features. */
export function useClusterSettled(): boolean {
  const { currentCluster } = useCluster()
  return selectionSettled(useClusterList(), currentCluster)
}

/**
 * The selection reconciled to the clusters this user can access, once the list has answered. Besides the initial
 * auto-select, this corrects a selection left over from a previous login: a cluster the current user can't access (or
 * any stale id) must not stay selected, or the axios interceptor keeps sending ?cluster=<it> and the server now 403s
 * every read. Prefer the cluster the initial Setup registers (id "default") over registry order. With no accessible
 * cluster, clear the selection so no ?cluster= is sent at all. A list that could not be read changes nothing: the
 * selection waits for its answer.
 */
export function useAccessibleClusterSelection(): void {
  const { currentCluster, setCurrentCluster } = useCluster()
  const { data: clusters } = useClusterList()

  useEffect(() => {
    if (!clusters) return
    if (clusters.length === 0) {
      if (currentCluster) setCurrentCluster('')
      return
    }
    const accessible = clusters.some((c) => c.id === currentCluster)
    if (!currentCluster || !accessible) {
      const preferred = clusters.find((c) => c.id === 'default') ?? clusters[0]
      if (preferred.id !== currentCluster) setCurrentCluster(preferred.id)
    }
  }, [currentCluster, clusters, setCurrentCluster])
}
