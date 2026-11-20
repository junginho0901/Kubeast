const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])',
  'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',')

// The visible elements Tab can reach inside root, in order.
export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0)
}

type TabKey = Pick<KeyboardEvent, 'shiftKey' | 'defaultPrevented' | 'preventDefault'>

// Node.DOCUMENT_POSITION_PRECEDING and _FOLLOWING, without the DOM's globals
const BEFORE = 2
const AFTER = 4

/**
 * Tab inside the top-most modal layer, a window (`ModalOverlay`) or the detail drawer (W3C APG Dialog (Modal)): past its
 * last control to its first, before its first to its last — also from a place out of the Tab order, such as the
 * drawer's title — and into it from outside. Between them the browser moves it, and a key an editor took (Monaco
 * indenting) is left alone.
 */
export function keepTabIn(root: HTMLElement, e: TabKey, active: Element | null): void {
  if (e.defaultPrevented) return
  const list = focusables(root)
  if (list.length === 0) {
    e.preventDefault()
    return
  }
  const toward = e.shiftKey ? BEFORE : AFTER
  if (active && root.contains(active) && list.some((el) => el !== active && active.compareDocumentPosition(el) & toward)) return
  e.preventDefault()
  ;(e.shiftKey ? list[list.length - 1] : list[0]).focus()
}
