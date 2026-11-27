import { type RefObject, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useCluster } from '@/contexts/ClusterContext'

const READING_SURFACE = 'main, .chat-scroll-surface'
const REST_MS = 500

/** Only the page and the detail drawer count as reading; the chat and sidebar have their own scrolls. */
export function watchChatScroll(doc: Document, win: Window, button: () => HTMLButtonElement | null, change: (hidden: boolean) => void): () => void {
  const positions = new WeakMap<Element, number>()
  let pointer: { x: number; y: number } | null = null
  let timer: number | undefined
  let hidden = false
  const viewport = () => doc.scrollingElement
  const setHidden = (next: boolean) => {
    if (hidden === next) return
    hidden = next
    change(next)
  }
  const reveal = () => {
    win.clearTimeout(timer)
    timer = undefined
    setHidden(false)
  }
  const reading = (el: Element) => !!el.closest(READING_SURFACE) && !el.closest('[data-testid="floating-chat-panel"]')
  const remember = (el: Element | null) => {
    if (el) positions.set(el, Math.max(0, el.scrollTop))
  }
  const seed = () => {
    remember(viewport())
    for (const root of doc.querySelectorAll(READING_SURFACE)) {
      remember(root)
      for (const el of root.querySelectorAll('[class*="overflow-"]')) if (reading(el)) remember(el)
    }
  }
  const protectedButton = () => {
    const el = button()
    if (el?.contains(doc.activeElement)) return true
    if (!pointer) return false
    if (pointer.x >= win.innerWidth - 110 && pointer.y >= win.innerHeight - 110) return true
    if (pointer.y < win.innerHeight - 110) return false
    if (!el) return false
    const rect = el.getBoundingClientRect()
    // The drawer moves the button away from the corner; approaching that button also keeps it available.
    return pointer.x >= rect.left - 24 && pointer.x <= rect.right + 24
      && pointer.y >= rect.top - 24 && pointer.y <= rect.bottom + 24
  }
  const elementOf = (target: EventTarget | null) => target && 'nodeType' in target && target.nodeType === 1 ? target as Element : null
  const beforeScroll = (event: Event) => {
    // Wheel, scrollbar dragging and keyboard scrolling see the position before it changes, including new inner lists.
    for (let el = elementOf(event.target); el; el = el.parentElement) if (reading(el)) remember(el)
    remember(viewport())
  }
  const onScroll = (event: Event) => {
    const el = event.target === doc ? viewport() : elementOf(event.target)
    if (!el || (el !== viewport() && !reading(el))) return
    const next = Math.max(0, el.scrollTop)
    const previous = positions.get(el)
    remember(el)
    if (el.scrollHeight <= el.clientHeight || protectedButton()) {
      reveal()
      return
    }
    // An unobserved programmatic jump gives no direction; do not mistake it for reading down.
    if (previous === undefined || next < previous) {
      reveal()
      return
    }
    if (next === previous) return
    setHidden(true)
    win.clearTimeout(timer)
    timer = win.setTimeout(reveal, REST_MS)
  }
  const onPointer = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return
    pointer = { x: event.clientX, y: event.clientY }
    if (protectedButton()) reveal()
  }
  const onLeave = () => { pointer = null }
  const onFocus = () => { if (protectedButton()) reveal() }
  const onResize = () => { reveal(); seed() }
  seed()
  doc.addEventListener('scroll', onScroll, { capture: true, passive: true })
  doc.addEventListener('wheel', beforeScroll, { capture: true, passive: true })
  doc.addEventListener('pointerdown', beforeScroll, { capture: true, passive: true })
  doc.addEventListener('keydown', beforeScroll, true)
  doc.addEventListener('pointermove', onPointer, { passive: true })
  doc.addEventListener('pointerleave', onLeave)
  doc.addEventListener('focusin', onFocus)
  win.addEventListener('resize', onResize)
  return () => {
    win.clearTimeout(timer)
    doc.removeEventListener('scroll', onScroll, { capture: true })
    doc.removeEventListener('wheel', beforeScroll, { capture: true })
    doc.removeEventListener('pointerdown', beforeScroll, { capture: true })
    doc.removeEventListener('keydown', beforeScroll, { capture: true })
    doc.removeEventListener('pointermove', onPointer)
    doc.removeEventListener('pointerleave', onLeave)
    doc.removeEventListener('focusin', onFocus)
    win.removeEventListener('resize', onResize)
  }
}

export function useChatScrollVisibility(button: RefObject<HTMLButtonElement | null>, paused: boolean): boolean {
  const [hidden, setHidden] = useState(false)
  const location = useLocation()
  const { currentCluster } = useCluster()
  useEffect(() => {
    setHidden(false)
    if (paused) return
    return watchChatScroll(document, window, () => button.current, setHidden)
  }, [button, paused, location.key, currentCluster])
  return !paused && hidden
}
