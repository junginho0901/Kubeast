type Doc = { activeElement: Element | null; body: Element | null }
type Focusable = { focus(): void }

/** The focus fell to the page: what had it left the page (a button that turned into another) or could not keep it. */
export function focusDropped(doc: Doc): boolean {
  const active = doc.activeElement
  return !active || active === doc.body || !active.isConnected
}

/** Moves a dropped focus to `next` (WCAG 2.4.3); a focus the reader put somewhere stays there. */
export function refocusIfDropped(doc: Doc, next: Focusable | null | undefined): boolean {
  if (!next || !focusDropped(doc)) return false
  next.focus()
  return true
}
