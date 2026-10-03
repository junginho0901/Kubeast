import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQueryClient, useIsFetching } from '@tanstack/react-query'

import { clustersApi } from '@/services/api/clusters'
import { setCurrentClusterRef } from '@/services/clusterRef'
import { isClusterScopedQueryKey } from '@/utils/clusterQueryScope'
import { ClusterContext, STORAGE_KEY } from './ClusterContext'

// Provider half of ClusterContext, in its own file so Fast Refresh treats it as
// a component module. Design notes live in ClusterContext.tsx.
export function ClusterProvider({ children }: { children: ReactNode }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()

  const fromUrl = searchParams.get('cluster') || ''
  const fromStorage =
    typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) || '' : ''
  const currentCluster = fromUrl || fromStorage

  // Keep the non-React module ref in sync. Set synchronously too so the first
  // request issued in this render already carries the cluster.
  setCurrentClusterRef(currentCluster)
  useEffect(() => {
    setCurrentClusterRef(currentCluster)
    // A cluster chosen through the URL (?cluster=, deep link) is remembered
    // like one chosen in the picker, so an in-app navigation that drops the
    // query (release detail, drawers) stays on that cluster instead of falling
    // back to the stored or default one.
    if (fromUrl && fromUrl !== fromStorage && typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, fromUrl)
    }
  }, [currentCluster, fromUrl, fromStorage])

  // On an actual cluster change, drop the cluster-scoped query cache so the new
  // cluster's data is fetched fresh (no cross-cluster bleed). Cluster-independent
  // caches (identity, registry, sessions, …) are kept — see clusterQueryScope.
  // The active page's queries refetch immediately; others refetch lazily on
  // navigation. Skips the initial mount.
  const prevClusterRef = useRef(currentCluster)
  const [isSwitching, setIsSwitching] = useState(false)
  const switchStartRef = useRef(0)
  useEffect(() => {
    const prev = prevClusterRef.current
    if (prev === currentCluster) return
    prevClusterRef.current = currentCluster
    // Skip the initial population ('' → first cluster, e.g. the picker's
    // auto-select): there is no prior cluster's cache to clear, and clearing
    // here would needlessly refetch the just-loaded page on every fresh visit.
    if (!prev) return
    queryClient.removeQueries({ predicate: (q) => isClusterScopedQueryKey(q.queryKey) })
    // Drive the global switch indicator until the new cluster's queries settle.
    switchStartRef.current = Date.now()
    setIsSwitching(true)
  }, [currentCluster, queryClient])

  // Hide the indicator once the new cluster's queries have drained — but keep it
  // up for a minimum so a fast (cached / local) switch is perceptible instead of
  // a flicker. While queries are in flight it stays visible; a switch on a page
  // with no cluster-scoped data clears after the minimum, so it never sticks.
  const clusterFetching = useIsFetching({
    predicate: (q) => isClusterScopedQueryKey(q.queryKey),
  })
  useEffect(() => {
    if (!isSwitching) return
    if (clusterFetching > 0) return // stay visible while the refetch runs
    const MIN_VISIBLE_MS = 700
    const remaining = MIN_VISIBLE_MS - (Date.now() - switchStartRef.current)
    const t = setTimeout(() => setIsSwitching(false), Math.max(0, remaining))
    return () => clearTimeout(t)
  }, [isSwitching, clusterFetching])

  const setCurrentCluster = (id: string) => {
    // A user-driven change from one cluster to another leaves an audit row.
    // The picker's first auto-select ('' → cluster) is not a switch.
    if (id && currentCluster && id !== currentCluster) {
      clustersApi.auditClusterSwitch(currentCluster, id).catch(() => {})
    }
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, id)
    }
    setCurrentClusterRef(id)
    const next = new URLSearchParams(searchParams)
    if (id) {
      next.set('cluster', id)
    } else {
      next.delete('cluster')
    }
    setSearchParams(next, { replace: true })
  }

  return (
    <ClusterContext.Provider value={{ currentCluster, setCurrentCluster, isSwitching }}>
      {children}
    </ClusterContext.Provider>
  )
}
