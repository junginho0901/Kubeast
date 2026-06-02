import { useEffect, useRef, useState } from 'react'

// 좌측 세션 사이드바의 가상 스크롤을 위한 viewport 관측. 스크롤 위치와 viewport 높이를
// 추적하며 바닥에 닿으면 다음 페이지 fetch 를 트리거한다. RAF 로 스크롤 이벤트를
// throttle 한다.

interface Params {
  sessionsHasNextPage: boolean | undefined
  sessionsFetchingNextPage: boolean
  fetchNextSessionsPage: () => unknown
}

interface Result {
  sessionsScrollRef: React.RefObject<HTMLDivElement>
  sessionsScrollTop: number
  sessionsViewportHeight: number
  handleSessionsScroll: (e: React.UIEvent<HTMLDivElement>) => void
}

export function useSessionsScrollViewport({
  sessionsHasNextPage,
  sessionsFetchingNextPage,
  fetchNextSessionsPage,
}: Params): Result {
  const sessionsScrollRef = useRef<HTMLDivElement>(null)
  const sessionsScrollRafRef = useRef<number | null>(null)
  const [sessionsScrollTop, setSessionsScrollTop] = useState(0)
  const [sessionsViewportHeight, setSessionsViewportHeight] = useState(0)

  useEffect(() => {
    const el = sessionsScrollRef.current
    if (!el) return

    const update = () => {
      setSessionsViewportHeight(el.clientHeight || 0)
      setSessionsScrollTop(el.scrollTop || 0)
    }

    update()

    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const maybeFetchMoreSessions = (container: HTMLDivElement) => {
    if (!sessionsHasNextPage) return
    if (sessionsFetchingNextPage) return
    const remaining = container.scrollHeight - container.scrollTop - container.clientHeight
    if (remaining <= 1) {
      void fetchNextSessionsPage()
    }
  }

  const handleSessionsScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const container = e.currentTarget

    if (sessionsScrollRafRef.current != null) {
      cancelAnimationFrame(sessionsScrollRafRef.current)
    }

    sessionsScrollRafRef.current = requestAnimationFrame(() => {
      setSessionsScrollTop(container.scrollTop)
      maybeFetchMoreSessions(container)
      sessionsScrollRafRef.current = null
    })
  }

  return { sessionsScrollRef, sessionsScrollTop, sessionsViewportHeight, handleSessionsScroll }
}
