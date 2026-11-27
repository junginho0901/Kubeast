type Doc = { activeElement: Element | null; body: Element | null }
type Focusable = { focus(): void; isConnected: boolean }
type Inside = { contains(node: Node | null): boolean }

/**
 * What the shortcut does: it opens the closed chat and closes the chat the focus is in. While the chat is open and the
 * focus is elsewhere (a drawer or a window under it, the page), it brings the focus in instead (`focusChat`), so a first
 * press from a drawer does not close the chat the reader wanted to type in.
 */
export function shortcutStep(isOpen: boolean, doc: Doc, panel: Inside | null): 'open' | 'close' | 'focus' {
  if (!isOpen) return 'open'
  const active = doc.activeElement
  return active && panel?.contains(active) ? 'close' : 'focus'
}

/** The focus into the open chat: its input, else the window itself (the input takes none while a conversation is made). */
export function focusChat(doc: Doc, input: { focus(): void } | null, panel: { focus(): void } | null): 'input' | 'window' | 'none' {
  input?.focus()
  if (input && (doc.activeElement as unknown) === input) return 'input'
  panel?.focus()
  if (panel && (doc.activeElement as unknown) === panel) return 'window'
  return 'none'
}

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
