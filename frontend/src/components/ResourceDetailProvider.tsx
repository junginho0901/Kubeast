import { useState, useCallback, useRef, type ReactNode } from 'react'
import { ResourceDetailContext, type ResourceDetailTarget } from './ResourceDetailContext'

export function ResourceDetailProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<ResourceDetailTarget | null>(null)
  const historyRef = useRef<ResourceDetailTarget[]>([])

  const open = useCallback((t: ResourceDetailTarget) => {
    setTarget(prev => {
      if (prev) historyRef.current.push(prev)
      return t
    })
  }, [])

  const close = useCallback(() => {
    historyRef.current = []
    setTarget(null)
  }, [])

  const goBack = useCallback(() => {
    const prev = historyRef.current.pop()
    setTarget(prev ?? null)
  }, [])

  const canGoBack = historyRef.current.length > 0

  return (
    <ResourceDetailContext.Provider value={{ target, open, close, goBack, canGoBack }}>
      {children}
    </ResourceDetailContext.Provider>
  )
}
