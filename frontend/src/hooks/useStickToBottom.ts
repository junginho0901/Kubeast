import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DependencyList } from 'react'

// A chat list that follows new text only while the reader is at the bottom (as use-stick-to-bottom does): scrolling
// up stops it and shows a "jump to latest" control; jumping, or sending a question, scrolls back smoothly and follows
// again. Only the reader's scrolling decides — text growing below the view never counts as scrolling up.

const NEAR_BOTTOM_PX = 80
const PROGRAMMATIC_MS = 700 // a smooth jump's own scroll events do not count as the reader's

type ScrollBox = { scrollHeight: number; scrollTop: number; clientHeight: number }

export function distanceFromBottom(el: ScrollBox): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight
}

// the reader is "at the bottom" within a short reach of it (a wheel notch above still counts)
export function isNearBottom(el: ScrollBox): boolean {
  return distanceFromBottom(el) <= NEAR_BOTTOM_PX
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

export function useStickToBottom<T extends HTMLElement>(contentDeps: DependencyList) {
  const ref = useRef<T | null>(null)
  const following = useRef(true)
  const programmaticUntil = useRef(0)
  const [atBottom, setAtBottom] = useState(true)

  const setFollowing = useCallback((value: boolean) => {
    following.current = value
    setAtBottom(value)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      if (performance.now() < programmaticUntil.current) return
      setFollowing(isNearBottom(el))
    }
    // scrolling up is the reader's intent at once, even during a smooth jump
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        programmaticUntil.current = 0
        setFollowing(false)
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
    }
  }, [setFollowing])

  // new text: keep the bottom in view while following (instant — each piece moves the view by a line at most)
  useLayoutEffect(() => {
    const el = ref.current
    if (el && following.current) el.scrollTop = el.scrollHeight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, contentDeps)

  // smooth for the reader's jump and a new question; instant when another conversation opens
  const scrollToBottom = useCallback((opts?: { instant?: boolean }) => {
    const el = ref.current
    if (!el) return
    setFollowing(true)
    const smooth = !opts?.instant && !prefersReducedMotion()
    programmaticUntil.current = smooth ? performance.now() + PROGRAMMATIC_MS : 0
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [setFollowing])

  return { ref, atBottom, scrollToBottom }
}
