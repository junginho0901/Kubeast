import { focusables } from '@/utils/focusables'

type DrawerKey = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'defaultPrevented' | 'preventDefault' | 'stopPropagation'>

// Node.DOCUMENT_POSITION_PRECEDING and _FOLLOWING, without the DOM's globals
const BEFORE = 2
const AFTER = 4

/**
 * Tab inside the open drawer (W3C APG Dialog (Modal)): past its last control to its first, before its first to its last
 * — also from its title, which is out of the Tab order — and into it from outside. Between them the browser moves it,
 * and a key an editor took (Monaco indenting) is left alone.
 */
export function keepTabIn(panel: HTMLElement, e: DrawerKey, active: Element | null): void {
  if (e.defaultPrevented) return
  const list = focusables(panel)
  if (list.length === 0) {
    e.preventDefault()
    return
  }
  const toward = e.shiftKey ? BEFORE : AFTER
  if (active && panel.contains(active) && list.some((el) => el !== active && active.compareDocumentPosition(el) & toward)) return
  e.preventDefault()
  ;(e.shiftKey ? list[list.length - 1] : list[0]).focus()
}

/**
 * The open drawer's keys, while it is the top-most layer — a window opened over it takes them: Escape closes it and Tab
 * stays in it. It listens after the page (window, bubbling), so the floating chat, which keeps its own keys, is not
 * reached.
 */
export function drawerKeydown(panel: () => HTMLElement | null, isTop: () => boolean, close: () => void,
  doc: { activeElement: Element | null }): (e: DrawerKey) => void {
  return (e) => {
    if (!isTop()) return
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
    } else if (e.key === 'Tab') {
      const el = panel()
      if (el) keepTabIn(el, e, doc.activeElement)
    }
  }
}
