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

const uncovered = () => false

/** An open panel with lists of its own: Escape closes it and gives the focus back to its button. It listens after the
 *  lists (bubble, where useDismiss listens in capture), so while one is open Escape closes only that list. A panel
 *  drawn in the page passes `covered` (a window or the drawer open over it), read before any of them hears the key:
 *  the one that closes on it may be gone from the page before the panel hears it. */
export function panelEscape(
  target: Pick<Document, 'addEventListener' | 'removeEventListener'>,
  close: () => void,
  opener: () => { focus(): void } | null,
  covered: () => boolean = uncovered,
): () => void {
  const { onKey } = dismissHandlers(() => null, () => {
    close()
    opener()?.focus()
  })
  let coveredAtPress = false
  const look = () => { coveredAtPress = covered() }
  const onPanelKey = (e: KeyboardEvent) => { if (!coveredAtPress) onKey(e) }
  target.addEventListener('keydown', look, true)
  target.addEventListener('keydown', onPanelKey)
  return () => {
    target.removeEventListener('keydown', look, true)
    target.removeEventListener('keydown', onPanelKey)
  }
}

/** While `open`, Escape sets it closed (`setOpen(false)`) and focuses `opener`, unless `covered()`. */
export function usePanelEscape(
  open: boolean,
  opener: RefObject<{ focus(): void } | null>,
  setOpen: (open: boolean) => void,
  covered?: () => boolean,
): void {
  useEffect(() => {
    if (!open) return
    return panelEscape(document, () => setOpen(false), () => opener.current, covered)
  }, [open, opener, setOpen, covered])
}
