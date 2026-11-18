import { describe, expect, it, vi } from 'vitest'
import { dismissHandlers, panelEscape } from './useDismiss'

// Codex QA Q10: the Namespace and Fit lists stayed open on Escape.
describe('dismissHandlers', () => {
  const inside = { node: {} as Node }
  const box = { contains: (n: Node | null) => n === inside.node }

  it('Escape closes the list and goes no further', () => {
    const close = vi.fn()
    const stopPropagation = vi.fn()
    dismissHandlers(() => box, close).onKey({ key: 'Escape', isComposing: false, stopPropagation })
    expect(close).toHaveBeenCalledTimes(1)
    expect(stopPropagation).toHaveBeenCalledTimes(1)
  })

  it('another key, or Escape while an input method composes, leaves it open and passes on', () => {
    const close = vi.fn()
    const stopPropagation = vi.fn()
    const { onKey } = dismissHandlers(() => box, close)
    onKey({ key: 'Enter', isComposing: false, stopPropagation })
    onKey({ key: 'Escape', isComposing: true, stopPropagation })
    expect(close).not.toHaveBeenCalled()
    expect(stopPropagation).not.toHaveBeenCalled()
  })

  it('a press outside closes it, a press inside does not', () => {
    const close = vi.fn()
    const { onPress } = dismissHandlers(() => box, close)
    onPress({ target: inside.node as EventTarget })
    expect(close).not.toHaveBeenCalled()
    onPress({ target: {} as EventTarget })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('a list no longer on the page is not closed by a press', () => {
    const close = vi.fn()
    dismissHandlers(() => null, close).onPress({ target: {} as EventTarget })
    expect(close).not.toHaveBeenCalled()
  })
})

type Key = { key: string; isComposing: boolean; stopPropagation: () => void }
type Listener = (e: Key) => void

// A key pressed in the page goes, as the DOM Standard dispatches it, to the document's capture listeners, then to the
// page under it (the React root, where the floating chat's panel takes its keys), then to the document's bubble
// listeners and the window's. stopPropagation skips what comes after, not the other listeners of the same node.
function page() {
  const doc: { fn: Listener; capture: boolean }[] = []
  const root: Listener[] = []
  const win: Listener[] = []
  const target = {
    addEventListener: (_type: string, fn: Listener, capture = false) => { doc.push({ fn, capture }) },
    removeEventListener: (_type: string, fn: Listener, capture = false) => {
      const i = doc.findIndex((l) => l.fn === fn && l.capture === capture)
      if (i >= 0) doc.splice(i, 1)
    },
  }
  const press = (key: string, isComposing = false) => {
    let stopped = false
    const e: Key = { key, isComposing, stopPropagation: () => { stopped = true } }
    for (const fns of [() => doc.filter((l) => l.capture).map((l) => l.fn), () => root, () => doc.filter((l) => !l.capture).map((l) => l.fn), () => win]) {
      if (stopped) return
      for (const fn of fns()) fn(e)
    }
  }
  return { document: target as unknown as Document, root, win, press, listening: () => doc.length }
}

// Advanced Search's Settings panel stayed open on Escape.
describe('panelEscape', () => {
  it('Escape closes the panel, gives the focus back to its button and goes no further', () => {
    const p = page()
    const close = vi.fn()
    const button = { focus: vi.fn() }
    const drawer = vi.fn()
    p.win.push((e) => { if (e.key === 'Escape') drawer() })
    panelEscape(p.document, close, () => button)
    p.press('Escape')
    expect(close).toHaveBeenCalledTimes(1)
    expect(button.focus).toHaveBeenCalledTimes(1)
    expect(drawer).not.toHaveBeenCalled()
  })

  it('another key, or Escape while an input method composes, leaves it open', () => {
    const p = page()
    const close = vi.fn()
    const button = { focus: vi.fn() }
    panelEscape(p.document, close, () => button)
    p.press('Enter')
    p.press('Escape', true)
    expect(close).not.toHaveBeenCalled()
    expect(button.focus).not.toHaveBeenCalled()
  })

  it('a list open inside it takes the first Escape, the second closes the panel', () => {
    const p = page()
    const close = vi.fn()
    const button = { focus: vi.fn() }
    panelEscape(p.document, close, () => button)
    // the refresh interval list opened after the panel, as CustomDropdown's useDismiss listens
    const closeList = vi.fn(() => p.document.removeEventListener('keydown', list, true))
    const list = dismissHandlers(() => null, closeList).onKey as unknown as EventListener
    p.document.addEventListener('keydown', list, true)
    p.press('Escape')
    expect(closeList).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
    p.press('Escape')
    expect(closeList).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(button.focus).toHaveBeenCalledTimes(1)
  })

  it('an Escape the floating chat took is not the panel\'s', () => {
    const p = page()
    const close = vi.fn()
    const chat = vi.fn()
    p.root.push((e) => { if (e.key === 'Escape') { e.stopPropagation(); chat() } })
    panelEscape(p.document, close, () => null)
    p.press('Escape')
    expect(chat).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
  })

  it('a button no longer on the page is not focused, and the panel closing stops listening', () => {
    const p = page()
    const close = vi.fn()
    const stop = panelEscape(p.document, close, () => null)
    p.press('Escape')
    expect(close).toHaveBeenCalledTimes(1)
    stop()
    expect(p.listening()).toBe(0)
    p.press('Escape')
    expect(close).toHaveBeenCalledTimes(1)
  })
})
