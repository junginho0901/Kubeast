import type { KeyboardEvent } from 'react'

type RowKey = Pick<KeyboardEvent, 'key' | 'target' | 'currentTarget' | 'repeat' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'preventDefault'>

/** Enter or Space on the row itself: a key on a button or link inside it stays that control's, and a held or modified key opens nothing. */
export function opensOnKey(e: RowKey): boolean {
  if (e.key !== 'Enter' && e.key !== ' ') return false
  if (e.target !== e.currentTarget || e.repeat) return false
  return !(e.altKey || e.ctrlKey || e.metaKey || e.shiftKey)
}

type Row = { tagName: string; cells?: ArrayLike<{ innerText?: string; textContent: string | null }>; setAttribute: (name: string, value: string) => void }
type RowFocus = { target: unknown; currentTarget: Row }

/** A table row's cells as they read on screen, joined: the name a focused row is given. */
export function rowName(row: Row): string {
  return Array.from(row.cells ?? [], (c) => (c.innerText ?? c.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(', ')
}

/** On the row's own focus its cells become its name (WCAG 4.1.2): VoiceOver read a focused `<tr>` as "list box" and none of its text. */
export function nameRowOnFocus(e: RowFocus): void {
  if (e.target !== e.currentTarget || e.currentTarget.tagName !== 'TR') return
  const name = rowName(e.currentTarget)
  if (name) e.currentTarget.setAttribute('aria-label', name)
}

/**
 * What a list row that opens something on a press spreads on itself (WCAG 2.1.1): the click as before, a place in the
 * Tab order and Enter or Space for the keyboard. A `<tr>` keeps its row role and is named on its focus (`nameRowOnFocus`);
 * `button` reads a box outside a table as a button. `data-open-row` draws the focus ring (index.css) and lets the drawer
 * find the row's list (drawerFocus).
 */
export function openOnPress(open: () => void, options: { button?: boolean } = {}) {
  return {
    tabIndex: 0,
    ...(options.button ? { role: 'button' } : {}),
    'data-open-row': '',
    onClick: () => open(),
    onFocus: nameRowOnFocus,
    onKeyDown: (e: RowKey) => {
      if (!opensOnKey(e)) return
      // Space would scroll the page
      e.preventDefault()
      open()
    },
  }
}
