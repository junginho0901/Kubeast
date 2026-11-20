import { keepTabIn } from '@/utils/focusables'

type DrawerKey = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'defaultPrevented' | 'preventDefault' | 'stopPropagation'>

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
