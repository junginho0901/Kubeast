import { useState, useCallback, useRef, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ResourceDetailContext, type ResourceDetailTarget } from './ResourceDetailContext'

// The open drawer is also kept in the query — ?detail=<Kind>/<namespace>/<name> (<Kind>/<name> for cluster-scoped
// kinds), plus detailApi=<apiVersion> for custom resources — so a reload or a shared link opens the same drawer.
// Argo CD keeps its resource panel in the query the same way (?node=…, replaced, not pushed). The drawer follows the
// state at once (a closed drawer must not render its target again while the URL catches up — a deleted object would
// be fetched once more); the URL is read when it changes from outside (a load, another screen, back/forward).
const DETAIL = 'detail'
const DETAIL_API = 'detailApi'

function toParam(t: ResourceDetailTarget): string {
  return [t.kind, t.namespace, t.name].filter(Boolean).join('/')
}

function keyOf(t: ResourceDetailTarget | null): string {
  return t ? `${toParam(t)}|${t.apiVersion ?? ''}` : '|'
}

function fromParam(value: string | null, apiVersion: string | null): ResourceDetailTarget | null {
  if (!value) return null
  const parts = value.split('/')
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !p)) return null
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(parts[0])) return null
  const target: ResourceDetailTarget = parts.length === 3
    ? { kind: parts[0], namespace: parts[1], name: parts[2] }
    : { kind: parts[0], name: parts[1] }
  return apiVersion ? { ...target, apiVersion } : target
}

export function ResourceDetailProvider({ children }: { children: ReactNode }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const urlKey = `${searchParams.get(DETAIL) ?? ''}|${searchParams.get(DETAIL_API) ?? ''}`
  const [target, setTarget] = useState<ResourceDetailTarget | null>(() =>
    fromParam(searchParams.get(DETAIL), searchParams.get(DETAIL_API)))
  // the URL as last seen, and the one this provider asked for and is waiting to land
  const [syncedKey, setSyncedKey] = useState(urlKey)
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const historyRef = useRef<ResourceDetailTarget[]>([])

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
    setTarget(t)
    setPendingKey(keyOf(t))
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (t) {
        next.set(DETAIL, toParam(t))
        if (t.apiVersion) next.set(DETAIL_API, t.apiVersion)
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
