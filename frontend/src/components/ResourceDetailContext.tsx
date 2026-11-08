import { createContext, useContext } from 'react'

export interface ResourceDetailTarget {
  kind: string
  name: string
  namespace?: string
  apiVersion?: string
  rawJson?: Record<string, unknown>
  // When the drawer was handed its row (ResourceDetailProvider): a read of the object from before then is older than the row.
  openedAt?: number
}

export interface ResourceDetailContextValue {
  target: ResourceDetailTarget | null
  open: (t: ResourceDetailTarget) => void
  close: () => void
  goBack: () => void
  canGoBack: boolean
}

export const ResourceDetailContext = createContext<ResourceDetailContextValue>({
  target: null,
  open: () => {},
  close: () => {},
  goBack: () => {},
  canGoBack: false,
})

export function useResourceDetail() {
  return useContext(ResourceDetailContext)
}
