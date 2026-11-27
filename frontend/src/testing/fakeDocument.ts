import { vi } from 'vitest'

// For unit tests (node, no DOM): a `document` that keeps its listeners, and a key pressed as the DOM dispatches it to
// the document's capture listeners first. `install` in beforeEach, `vi.unstubAllGlobals()` after.
type Listener = { type: string; fn: (e: unknown) => void; capture: boolean }

export function fakeDocument() {
  const listeners: Listener[] = []
  const capture = (options?: boolean | { capture?: boolean }) => (typeof options === 'object' ? !!options.capture : !!options)
  const install = () => {
    listeners.length = 0
    vi.stubGlobal('document', {
      addEventListener: (type: string, fn: (e: unknown) => void, options?: boolean | { capture?: boolean }) => {
        listeners.push({ type, fn, capture: capture(options) })
      },
      removeEventListener: (type: string, fn: (e: unknown) => void, options?: boolean | { capture?: boolean }) => {
        const i = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture(options))
        if (i >= 0) listeners.splice(i, 1)
      },
    })
  }
  // the capture listeners hear it; returns what stopPropagation was called
  const pressKey = (key: string, isComposing = false) => {
    const stopPropagation = vi.fn()
    for (const l of listeners.filter((x) => x.type === 'keydown' && x.capture)) l.fn({ key, isComposing, stopPropagation })
    return stopPropagation
  }
  return { listeners, install, pressKey }
}
