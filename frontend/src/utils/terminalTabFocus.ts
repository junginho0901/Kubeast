type Key = Pick<KeyboardEvent, 'type' | 'key' | 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'preventDefault'>

/**
 * Ctrl+M (Ctrl+Shift+M on a Mac), the key Monaco and VS Code use to switch what Tab does, matched by the key's place
 * (`code`) so a Korean input source works too.
 */
export function isTabFocusToggle(e: Key, mac: boolean): boolean {
  return e.code === 'KeyM' && e.ctrlKey && !e.altKey && !e.metaKey && e.shiftKey === mac
}

/** The toggle as the hint writes it and as `aria-keyshortcuts` names it. */
export function tabFocusKeyNames(mac: boolean): { label: string; aria: string } {
  return mac ? { label: 'Ctrl+Shift+M', aria: 'Control+Shift+M' } : { label: 'Ctrl+M', aria: 'Control+M' }
}

/**
 * The terminal's key filter for xterm's `attachCustomKeyEventHandler`, where false leaves the key to the page. Tab,
 * Shift+Tab and Escape go to the shell; the toggle makes Tab and Shift+Tab move the focus instead, and back.
 */
export function terminalKeyFilter(mac: boolean, tabMovesFocus: () => boolean, toggle: () => void): (e: Key) => boolean {
  return (e) => {
    if (isTabFocusToggle(e, mac)) {
      if (e.type === 'keydown') {
        e.preventDefault()
        toggle()
      }
      return false
    }
    return !(e.key === 'Tab' && tabMovesFocus())
  }
}
