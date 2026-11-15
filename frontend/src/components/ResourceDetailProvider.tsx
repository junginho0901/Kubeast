import { useState, useCallback, useRef, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useCluster } from '@/contexts/ClusterContext'
import { ResourceDetailContext, type ResourceDetailTarget } from './ResourceDetailContext'
import { apiParam, fromParam, keyOf, toParam } from './detailParam'

// The open drawer is also kept in the query — ?detail=<Kind>/<namespace>/<name> (<Kind>/<name> for cluster-scoped
// kinds), plus detailApi=<group>/<version>/<plural> for a custom resource instance (detailParam) — so a reload or a
// shared link opens the same drawer. Argo CD keeps its resource panel in the query the same way (?node=…, replaced,
// not pushed). The drawer follows the state at once (a closed drawer must not render its target again while the URL
// catches up — a deleted object would be fetched once more); the URL is read when it changes from outside (a load,
// another screen, back/forward).
const DETAIL = 'detail'
const DETAIL_API = 'detailApi'

export function ResourceDetailProvider({ children }: { children: ReactNode }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const urlKey = `${searchParams.get(DETAIL) ?? ''}|${searchParams.get(DETAIL_API) ?? ''}`
  const [target, setTarget] = useState<ResourceDetailTarget | null>(() =>
    fromParam(searchParams.get(DETAIL), searchParams.get(DETAIL_API)))
  // the URL as last seen, and the one this provider asked for and is waiting to land
  const [syncedKey, setSyncedKey] = useState(urlKey)
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const historyRef = useRef<ResourceDetailTarget[]>([])
  // On another cluster the drawer stays open on what the address names, as a link opens it there: without the row
  // the list of the cluster before gave it, and without the way back to that cluster's objects.
  const { currentCluster } = useCluster()
  const [cluster, setCluster] = useState(currentCluster)
  if (cluster !== currentCluster) {
    setCluster(currentCluster)
    historyRef.current = []
    setTarget(fromParam(searchParams.get(DETAIL), searchParams.get(DETAIL_API)))
  }

  if (urlKey !== syncedKey) {
    setSyncedKey(urlKey)
    if (urlKey === pendingKey) {
      setPendingKey(null)
    } else if (urlKey !== keyOf(target)) {
      historyRef.current = []
      setTarget(fromParam(searchParams.get(DETAIL), searchParams.get(DETAIL_API)))
    }
  }

  const show = useCallback((t: ResourceDetailTarget | null) => {
    setTarget(t && t.openedAt === undefined ? { ...t, openedAt: Date.now() } : t)
    setPendingKey(keyOf(t))
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (t) {
        next.set(DETAIL, toParam(t))
        if (apiParam(t)) next.set(DETAIL_API, apiParam(t))
        else next.delete(DETAIL_API)
      } else {
        next.delete(DETAIL)
        next.delete(DETAIL_API)
      }
      return next
    }, { replace: true })
  }, [setSearchParams])

  const open = useCallback((t: ResourceDetailTarget) => {
    if (target) historyRef.current.push(target)
    show(t)
  }, [target, show])

  const close = useCallback(() => {
    historyRef.current = []
    show(null)
  }, [show])

  const goBack = useCallback(() => {
    show(historyRef.current.pop() ?? null)
  }, [show])

  const canGoBack = historyRef.current.length > 0

  return (
    <ResourceDetailContext.Provider value={{ target, open, close, goBack, canGoBack }}>
      {children}
    </ResourceDetailContext.Provider>
  )
}
