// ClusterContext — the selected cluster as first-class app state (step 09).
//
// Source of truth is the URL query (?cluster=), so each browser tab can target
// a different cluster independently (00-COMMON §2-7), with a localStorage
// fallback for fresh navigations. The selected id is mirrored into a module ref
// (services/clusterRef) that the axios interceptor and WS multiplexer read.
//
// Empty string = no explicit selection → axios omits ?cluster= → the server
// falls back to its default cluster (step 05). The ClusterPicker UI is step 11.

import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'

import { setCurrentClusterRef } from '@/services/clusterRef'

const STORAGE_KEY = 'kubeast:current-cluster'

type ClusterContextValue = {
  currentCluster: string
  setCurrentCluster: (id: string) => void
}

const ClusterContext = createContext<ClusterContextValue>({
  currentCluster: '',
  setCurrentCluster: () => {},
})

export function ClusterProvider({ children }: { children: ReactNode }) {
  const [searchParams, setSearchParams] = useSearchParams()

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
    <ClusterContext.Provider value={{ currentCluster, setCurrentCluster }}>
      {children}
    </ClusterContext.Provider>
  )
}

export function useCluster(): ClusterContextValue {
  return useContext(ClusterContext)
}
