import type { KeyboardEvent } from 'react'

type RowKey = Pick<KeyboardEvent, 'key' | 'target' | 'currentTarget' | 'repeat' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'preventDefault'>

/** Enter or Space on the row itself: a key on a button or link inside it stays that control's, and a held or modified key opens nothing. */
export function opensOnKey(e: RowKey): boolean {
  if (e.key !== 'Enter' && e.key !== ' ') return false
  if (e.target !== e.currentTarget || e.repeat) return false
  return !(e.altKey || e.ctrlKey || e.metaKey || e.shiftKey)
}

/**
 * What a list row that opens something on a press spreads on itself (WCAG 2.1.1): the click as before, a place in the
 * Tab order and Enter or Space for the keyboard. A `<tr>` keeps its row role; `button` reads a box outside a table as
 * a button. `data-open-row` draws the focus ring (index.css) and lets the drawer find the row's list (drawerFocus).
 */
export function openOnPress(open: () => void, options: { button?: boolean } = {}) {
  return {
    tabIndex: 0,
    ...(options.button ? { role: 'button' } : {}),
    'data-open-row': '',
    onClick: () => open(),
    onKeyDown: (e: RowKey) => {
      if (!opensOnKey(e)) return
      // Space would scroll the page
      e.preventDefault()
      open()
    },
  }
}
