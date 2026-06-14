// ClusterContext — the selected cluster as first-class app state (step 09).
//
// Source of truth is the URL query (?cluster=), so each browser tab can target
// a different cluster independently (00-COMMON §2-7), with a localStorage
// fallback for fresh navigations. The selected id is mirrored into a module ref
// (services/clusterRef) that the axios interceptor and WS multiplexer read.
//
// Empty string = no explicit selection → axios omits ?cluster= → the server
// falls back to its default cluster (step 05). The ClusterPicker UI is step 11.

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQueryClient, useIsFetching } from '@tanstack/react-query'

import { setCurrentClusterRef } from '@/services/clusterRef'
import { isClusterScopedQueryKey } from '@/utils/clusterQueryScope'

const STORAGE_KEY = 'kubeast:current-cluster'

// Drop the persisted cluster selection. Called on login so a new user never
// inherits the previous user's selected cluster (which they may not be able to
// access).
export function clearStoredCluster() {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(STORAGE_KEY)
  }
}

type ClusterContextValue = {
  currentCluster: string
  setCurrentCluster: (id: string) => void
  // True from the moment the user switches clusters until the new cluster's
  // cluster-scoped queries have settled — drives the global switch indicator.
  isSwitching: boolean
}

const ClusterContext = createContext<ClusterContextValue>({
  currentCluster: '',
  setCurrentCluster: () => {},
  isSwitching: false,
})

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
  }, [currentCluster])

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

export function useCluster(): ClusterContextValue {
  return useContext(ClusterContext)
}
