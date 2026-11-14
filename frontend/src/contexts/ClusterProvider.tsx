import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQueryClient, useIsFetching, type QueryClient } from '@tanstack/react-query'

import { clustersApi } from '@/services/api/clusters'
import { setCurrentClusterRef } from '@/services/clusterRef'
import { clearCreated } from '@/services/createdNoticeStore'
import { resetForbidden } from '@/services/forbiddenStore'
import { resetListStatus } from '@/services/listStatusStore'
import { resetWatchProblems } from '@/services/watchProblemStore'
import { dropClusterQueries, isClusterScopedQueryKey } from '@/utils/clusterQueryScope'
import { ClusterContext, STORAGE_KEY } from './ClusterContext'

// Everything that holds what a cluster answered moves to `cluster`: the requests from here on, the cluster-scoped
// query cache (cluster-independent caches — identity, registry, sessions, … — are kept, see clusterQueryScope; a
// query on screen asks again at once, others when next used) and the stores the API client and the watches feed
// (refusals, list statuses, watch problems, the created/deleted line).
function moveTo(queryClient: QueryClient, cluster: string) {
  setCurrentClusterRef(cluster)
  void dropClusterQueries(queryClient)
  resetForbidden()
  resetListStatus()
  resetWatchProblems()
  clearCreated()
}

// Provider half of ClusterContext, in its own file so Fast Refresh treats it as
// a component module. Design notes live in ClusterContext.tsx.
export function ClusterProvider({ children }: { children: ReactNode }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()

  const fromUrl = searchParams.get('cluster') || ''
  const fromStorage =
    typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) || '' : ''
  const chosen = fromUrl || fromStorage

  // The cluster the screen shows: it takes the chosen one in the same step as the cache and the stores (moveTo), so
  // no render names a cluster beside what the one before answered. React Router applies a URL change in a
  // transition; a page re-mounted under the new cluster (Layout's key) would otherwise read the old cache, the old
  // refusals and the old line for the frame before an effect emptied them.
  const [currentCluster, setShown] = useState(chosen)

  // Keep the non-React module ref in sync. Set synchronously too so the first
  // request issued in this render already carries the cluster.
  setCurrentClusterRef(currentCluster)
  useEffect(() => {
    // A cluster chosen through the URL (?cluster=, deep link) is remembered
    // like one chosen in the picker, so an in-app navigation that drops the
    // query (release detail, drawers) stays on that cluster instead of falling
    // back to the stored or default one.
    if (fromUrl && fromUrl !== fromStorage && typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, fromUrl)
    }
  }, [fromUrl, fromStorage])

  const [isSwitching, setIsSwitching] = useState(false)
  const switchStartRef = useRef(0)
  // A layout effect: React draws the state it sets before the browser paints, and the render naming the chosen
  // cluster is the first to find the cache and the stores emptied. Skips the initial mount.
  useLayoutEffect(() => {
    if (chosen === currentCluster) return
    moveTo(queryClient, chosen)
    setShown(chosen)
    // The first selection ('' → the picker's auto-select, after every sign-in) is
    // not a switch: no indicator. Its cache still goes: requests made while the
    // selection was empty reached the server's default cluster, which need not be
    // the one the picker chose — the dashboard showed `self`'s nodes as `default`.
    if (!currentCluster) return
    // Drive the global switch indicator until the new cluster's queries settle.
    switchStartRef.current = Date.now()
    setIsSwitching(true)
  }, [chosen, currentCluster, queryClient])

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

  // The URL changes here; the screen follows in the layout effect above.
  const setCurrentCluster = (id: string) => {
    // A user-driven change from one cluster to another leaves an audit row.
    // The picker's first auto-select ('' → cluster) is not a switch.
    if (id && currentCluster && id !== currentCluster) {
      clustersApi.auditClusterSwitch(currentCluster, id).catch(() => {})
    }
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, id)
    }
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
