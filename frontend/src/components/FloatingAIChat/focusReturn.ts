type Doc = { activeElement: Element | null; body: Element | null }
type Focusable = { focus(): void; isConnected: boolean }

/** What had the focus when the chat opened; null when it was the page itself. */
export function focusOrigin<T = HTMLElement>(doc: Doc): T | null {
  const active = doc.activeElement
  return active && active !== doc.body ? (active as T) : null
}

/**
 * Where the focus goes as the chat closes. A focus still in the window (or dropped to the page) goes back to what had
 * it when the chat opened; one the reader moved elsewhere meanwhile stays. 'toggle': the caller focuses the button
 * once it is shown again (it is aria-hidden while the window fades out).
 */
export function returnFocus(doc: Doc, panel: { contains(node: Node | null): boolean } | null, origin: Focusable | null, toggle: Focusable | null): 'back' | 'toggle' | 'stay' {
  const active = doc.activeElement
  if (active && active !== doc.body && !panel?.contains(active)) return 'stay'
  if (origin && origin !== toggle && origin.isConnected) {
    origin.focus()
    if ((doc.activeElement as unknown) === origin) return 'back'
  }
  return 'toggle'
}
