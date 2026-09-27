// ClusterContext — the selected cluster as first-class app state (step 09).
//
// Source of truth is the URL query (?cluster=), so each browser tab can target
// a different cluster independently (00-COMMON §2-7), with a localStorage
// fallback for fresh navigations. The selected id is mirrored into a module ref
// (services/clusterRef) that the axios interceptor and WS multiplexer read.
//
// Empty string = no explicit selection → axios omits ?cluster= → the server
// falls back to its default cluster (step 05). The ClusterPicker UI is step 11.

import { createContext, useContext } from 'react'

export const STORAGE_KEY = 'kubeast:current-cluster'

// Drop the persisted cluster selection. Called on login so a new user never
// inherits the previous user's selected cluster (which they may not be able to
// access).
export function clearStoredCluster() {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(STORAGE_KEY)
  }
}

export type ClusterContextValue = {
  currentCluster: string
  setCurrentCluster: (id: string) => void
  // True from the moment the user switches clusters until the new cluster's
  // cluster-scoped queries have settled — drives the global switch indicator.
  isSwitching: boolean
}

export const ClusterContext = createContext<ClusterContextValue>({
  currentCluster: '',
  setCurrentCluster: () => {},
  isSwitching: false,
})

export function useCluster(): ClusterContextValue {
  return useContext(ClusterContext)
}
