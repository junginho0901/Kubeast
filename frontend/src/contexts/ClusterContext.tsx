// ClusterContext — the selected cluster as first-class app state (step 09).
//
// Source of truth is the URL query (?cluster=), so each browser tab can target
// a different cluster independently (00-COMMON §2-7). Without it a tab keeps
// its own last choice. localStorage holds the last choice made in any tab: a
// new tab starts from it, and a later change there by another tab does not
// move this one (ClusterProvider). The selected id is mirrored into a module ref
// (services/clusterRef) that the axios interceptor and WS multiplexer read.
// `currentCluster` takes a new choice together with that ref, the cluster-scoped
// query cache and the stores fed by API answers, before the browser paints
// (ClusterProvider's moveTo), so nothing of the cluster before is ever drawn as
// the new one's.
//
// Empty string = no explicit selection → axios omits ?cluster= → the server
// falls back to its default cluster (step 05). The ClusterPicker UI is step 11.

import { createContext, useContext } from 'react'

export const STORAGE_KEY = 'kubeast:current-cluster'

// Drop the persisted cluster selection. Part of forgetCluster, which a sign-in
// calls so a new user never inherits the previous user's selected cluster
// (which they may not be able to access).
export function clearStoredCluster() {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(STORAGE_KEY)
  }
}

export type ClusterContextValue = {
  currentCluster: string
  setCurrentCluster: (id: string) => void
  // Drops this tab's choice and the stored one (a sign-in in this tab).
  forgetCluster: () => void
  // True from the moment the user switches clusters until the new cluster's
  // cluster-scoped queries have settled — drives the global switch indicator.
  isSwitching: boolean
}

export const ClusterContext = createContext<ClusterContextValue>({
  currentCluster: '',
  setCurrentCluster: () => {},
  forgetCluster: () => {},
  isSwitching: false,
})

export function useCluster(): ClusterContextValue {
  return useContext(ClusterContext)
}
