import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQueryClient, useIsFetching, type QueryClient } from '@tanstack/react-query'

import { clustersApi } from '@/services/api/clusters'
import { setCurrentClusterRef } from '@/services/clusterRef'
import { clearCreated } from '@/services/createdNoticeStore'
import { resetForbidden } from '@/services/forbiddenStore'
import { resetListStatus } from '@/services/listStatusStore'
import { resetWatchProblems } from '@/services/watchProblemStore'
import { askClusterQueriesOnScreen, dropClusterQueries, isClusterScopedQueryKey } from '@/utils/clusterQueryScope'
import { paramsForCluster } from '@/utils/clusterScopedParams'
import { ClusterContext, STORAGE_KEY, clearStoredCluster } from './ClusterContext'

// The cluster last chosen in any tab of this browser: where a new tab starts.
function readStoredCluster(): string {
  return typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) || '' : ''
}

function storeCluster(id: string) {
  if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, id)
}

// Everything that holds what a cluster answered moves to `cluster`: the requests from here on, the cluster-scoped
// query cache (cluster-independent caches — identity, registry, sessions, … — are kept, see clusterQueryScope; none
// is asked here, what is on screen once the new cluster is drawn asks then, others when next used) and the stores the
// API client and the watches feed (refusals, list statuses, watch problems, the created/deleted line).
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
  // This tab's own choice: the stored one when the tab starts, then only what this tab picks or its address names.
  // Another tab picking, or a sign-in there clearing the stored one, does not move it.
  const [tabChoice, setTabChoice] = useState(readStoredCluster)
  const chosen = fromUrl || tabChoice

  // The cluster the screen shows: it takes the chosen one in the same step as the cache and the stores (moveTo), so
  // no render names a cluster beside what the one before answered. React Router applies a URL change in a
  // transition; a page re-mounted under the new cluster (Layout's key) would otherwise read the old cache, the old
  // refusals and the old line for the frame before an effect emptied them.
  const [currentCluster, setShown] = useState(chosen)

  // Keep the non-React module ref in sync. Set synchronously too so the first
  // request issued in this render already carries the cluster.
  setCurrentClusterRef(currentCluster)
  useEffect(() => {
    // A cluster chosen through the URL (?cluster=, deep link) is this tab's
    // choice like one chosen in the picker, so an in-app navigation that drops
    // the query (release detail, drawers, the sidebar) stays on that cluster
    // instead of falling back to the stored or default one. It is stored too.
    if (!fromUrl) return
    setTabChoice(fromUrl)
    if (readStoredCluster() !== fromUrl) storeCluster(fromUrl)
  }, [fromUrl])

  const [isSwitching, setIsSwitching] = useState(false)
  const switchStartRef = useRef(0)
  const moved = useRef(false)
  // A layout effect: React draws the state it sets before the browser paints, and the render naming the chosen
  // cluster is the first to find the cache and the stores emptied. Skips the initial mount.
  useLayoutEffect(() => {
    if (chosen === currentCluster) return
    moveTo(queryClient, chosen)
    moved.current = true
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

  // The new cluster is drawn and the screens under it have asked for themselves (children's effects run first): a
  // query on screen that did not start again under it asks now, once.
  useEffect(() => {
    if (!moved.current) return
    moved.current = false
    void askClusterQueriesOnScreen(queryClient)
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

  // The URL changes here; the screen follows in the layout effect above. The address is read through a ref, so the
  // context value changes with the cluster or the indicator, not with every navigation.
  const latest = useRef({ searchParams, setSearchParams, currentCluster })
  useLayoutEffect(() => {
    latest.current = { searchParams, setSearchParams, currentCluster }
  })
  const setCurrentCluster = useCallback((id: string) => {
    const { searchParams, setSearchParams, currentCluster } = latest.current
    // A user-driven change from one cluster to another leaves an audit row.
    // The picker's first auto-select ('' → cluster) is not a switch.
    if (id && currentCluster && id !== currentCluster) {
      clustersApi.auditClusterSwitch(currentCluster, id).catch(() => {})
    }
    storeCluster(id)
    // a choice made is read by a render of its own, not only once the address change (a transition) lands
    setTabChoice(id)
    // a node of the cluster before (Cluster View's ?node=) is not one of the new cluster's
    setSearchParams(paramsForCluster(searchParams, id, currentCluster), { replace: true })
  }, [])
  // A sign-in in this tab: its choice and the stored one go, so a new user never starts on the previous user's cluster
  // (which they may not be able to reach); the screens' gate chooses again among theirs.
  const forgetCluster = useCallback(() => {
    clearStoredCluster()
    setTabChoice('')
  }, [])
  const value = useMemo(
    () => ({ currentCluster, setCurrentCluster, forgetCluster, isSwitching }),
    [currentCluster, setCurrentCluster, forgetCluster, isSwitching],
  )

  return (
    <ClusterContext.Provider value={value}>
      {children}
    </ClusterContext.Provider>
  )
}
