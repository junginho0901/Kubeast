import { useEffect, type RefObject } from 'react'

type Inside = { contains(node: Node | null): boolean } | null

/** What closes an open list: a press outside it, or Escape — which goes no further, so the window or drawer around it stays. */
export function dismissHandlers(inside: () => Inside, close: () => void) {
  return {
    onPress: (e: Pick<MouseEvent, 'target'>) => {
      const box = inside()
      if (box && !box.contains(e.target as Node)) close()
    },
    onKey: (e: Pick<KeyboardEvent, 'key' | 'isComposing' | 'stopPropagation'>) => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.stopPropagation()
      close()
    },
  }
}

/** While `open`, a press outside `ref` or Escape sets it closed (`setOpen(false)`). */
export function useDismiss(open: boolean, ref: RefObject<HTMLElement | null>, setOpen: (open: boolean) => void): void {
  useEffect(() => {
    if (!open) return
    const { onPress, onKey } = dismissHandlers(() => ref.current, () => setOpen(false))
    document.addEventListener('mousedown', onPress)
    // capture: before ModalOverlay's and the drawer's Escape, which listen on the document too
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onPress)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, ref, setOpen])
}
