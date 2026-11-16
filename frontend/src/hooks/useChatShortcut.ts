import { useEffect, useRef } from 'react'

type Platform = { platform?: string; userAgentData?: { platform?: string } }

/** A Mac (an iPad or iPhone with a keyboard too) takes ⌘ for app shortcuts; the others Ctrl. */
export function isMacPlatform(nav: Platform | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  return /mac|iphone|ipad|ipod/i.test(nav?.userAgentData?.platform || nav?.platform || '')
}

/** The floating chat's shortcut as its button names it: the tooltip text and `aria-keyshortcuts`. */
export function chatShortcutNames(mac: boolean): { label: string; aria: string } {
  return mac ? { label: '⌘/', aria: 'Meta+Slash' } : { label: 'Ctrl+/', aria: 'Control+Slash' }
}

type Key = Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'repeat' | 'defaultPrevented' | 'preventDefault'>

/**
 * ⌘/ on a Mac, Ctrl+/ elsewhere, matched by the key's place (`code`), so a Korean input source opens it too. It works
 * in a text field, as it types nothing; a key an editor took first (Monaco's comment toggle) or one pressed while an
 * input method composes is left alone. Only a handled key is prevented; a held key toggles once.
 */
export function chatShortcutKeydown(mac: boolean, enabled: () => boolean, toggle: () => void): (e: Key) => void {
  return (e) => {
    if (e.code !== 'Slash' || e.isComposing || e.defaultPrevented) return
    if (e.altKey || e.shiftKey || (mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey)) return
    if (!enabled()) return
    e.preventDefault()
    if (!e.repeat) toggle()
  }
}

/** Listens on `target` until the returned function is called. */
export function listenForChatShortcut(target: EventTarget, mac: boolean, enabled: () => boolean, toggle: () => void): () => void {
  const onKey = chatShortcutKeydown(mac, enabled, toggle)
  const listener = (e: Event) => onKey(e as KeyboardEvent)
  target.addEventListener('keydown', listener)
  return () => target.removeEventListener('keydown', listener)
}

/** One keydown listener on window while the caller is on the page; a re-render changes what it reads, not the listener. */
export function useChatShortcut(enabled: boolean, toggle: () => void): void {
  const latest = useRef({ enabled, toggle })
  useEffect(() => {
    latest.current = { enabled, toggle }
  })
  useEffect(() => listenForChatShortcut(window, isMacPlatform(), () => latest.current.enabled, () => latest.current.toggle()), [])
}
