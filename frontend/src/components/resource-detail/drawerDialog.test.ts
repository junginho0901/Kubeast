import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { elementsOf, fakeRender, fakeUnmount, textsOf } from '@/testing/fakeHooks'
import { drawerKeydown, keepTabIn } from './drawerDialog'
import { ResourceDetailHeader } from './ResourceDetailHeader'
import { chatShortcutKeydown } from '@/hooks/useChatShortcut'
import drawerSrc from '../ResourceDetailDrawer.tsx?raw'
import chatPanelSrc from '@/components/FloatingAIChat/ChatPanel.tsx?raw'

// The drawer covers the page with its backdrop (a press there closes it) and sits in the modal stack, but it said none of
// this to a screen reader and Tab walked out of it to the page behind (WCAG 2.2 2.1.1, 2.4.3, 4.1.2). It is now a modal
// dialog named by its kind and title that keeps Tab inside, below a window opened over it and beside the floating chat.

const ui = vi.hoisted(() => ({ overlay: null as unknown }))
vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), ...(await import('@/testing/fakeHooks')).fakeHooks }))
vi.mock('react-dom', async (original) => ({
  ...(await original<typeof import('react-dom')>()),
  createPortal: (node: { props: { ref: { current: unknown } } }) => { node.props.ref.current = ui.overlay; return node },
}))
vi.mock('@/hooks/useModalStack', () => ({ useModalStackEntry: () => ({ isTop: () => true, zIndex: 1210 }), modalOpen: () => true }))

import { ModalOverlay } from '@/components/ModalOverlay'

// Elements in document order, as the browser keeps them: one focus, a box that contains its children, a place before
// or after any other element, and the Tab order a selector reads (tabbable, shown).
class Page {
  order: El[] = []
  active: El | null = null
  el(name: string, parent: El | null, how: { tabbable?: boolean; focusable?: boolean; shown?: boolean } = {}) {
    return new El(this, name, parent, how.tabbable ?? false, how.focusable ?? how.tabbable ?? false, how.shown ?? true)
  }
}

class El {
  isConnected = true
  focus = vi.fn(() => { if (this.focusable) this.page.active = this })
  constructor(public page: Page, public name: string, public parent: El | null, public tabbable: boolean, public focusable: boolean, public shown: boolean) {
    page.order.push(this)
  }
  contains(node: unknown): boolean {
    for (let el = node as El | null; el; el = el.parent) if (el === this) return true
    return false
  }
  compareDocumentPosition(other: El): number {
    const order = this.page.order
    let at = order.indexOf(other) > order.indexOf(this) ? 4 : 2
    if (this.contains(other)) at |= 16
    if (other.contains(this)) at |= 8
    return at
  }
  querySelectorAll() { return this.page.order.filter((el) => el !== this && this.contains(el) && el.tabbable) }
  getClientRects() { return this.shown ? [{}] : [] }
}

// The page behind, the drawer (its title out of the Tab order), the floating chat's button and its open window.
function scene() {
  const page = new Page()
  const row = page.el('row', null, { tabbable: true })
  const drawer = page.el('drawer', null)
  const title = page.el('title', drawer, { focusable: true })
  const close = page.el('close', drawer, { tabbable: true })
  const info = page.el('info', drawer, { tabbable: true })
  const del = page.el('delete', drawer, { tabbable: true })
  const link = page.el('link', drawer, { tabbable: true })
  const chatButton = page.el('chat button', null, { tabbable: true })
  return { page, row, drawer, title, close, info, del, link, chatButton }
}

const as = <T>(el: unknown) => el as T
const docOf = (page: Page) => ({ get activeElement() { return as<Element | null>(page.active) } })
const keyOf = (key: string, shiftKey = false, defaultPrevented = false) => {
  const e = { key, shiftKey, defaultPrevented, preventDefault: vi.fn(() => { e.defaultPrevented = true }), stopPropagation: vi.fn() }
  return e
}
const tabKey = (shiftKey = false, defaultPrevented = false) => keyOf('Tab', shiftKey, defaultPrevented)

describe('the drawer as a dialog', () => {
  it('is a modal dialog named by its kind and its title, which the header carries', () => {
    const tree = ResourceDetailHeader({
      kind: 'ConfigMap', displayKind: 'ConfigMap', ns: 'kube-system', name: 'kube-root-ca.crt', effectiveRawJson: null,
      canGoBack: false, canDelete: true, tab: 'info', labelId: 'drawer-7', onClose: vi.fn(), onGoBack: vi.fn(),
      onTabChange: vi.fn(), onDeleteClick: vi.fn(), t: as((_key: string, o: { defaultValue: string }) => o.defaultValue),
    })
    const byId = (id: string) => elementsOf(tree, (props) => props.id === id)
    // aria-labelledby names them in this order, so a screen reader says "ConfigMap kube-root-ca.crt, dialog"
    const name = ['drawer-7-kind', 'drawer-7-title'].map((id) => byId(id).flatMap((el) => textsOf(el)).join('')).join(' ')
    expect(name).toBe('ConfigMap kube-root-ca.crt')
    expect(byId('drawer-7-title')[0].type).toBe('h2')
    expect(byId('drawer-7-title')[0].props.tabIndex).toBe(-1)

    const panel = drawerSrc.match(/<div\s+ref=\{panelRef\}([^>]*)>/)?.[1] ?? ''
    expect(panel).toMatch(/role="dialog"/)
    expect(panel).toMatch(/aria-modal="true"/)
    expect(panel).toContain('aria-labelledby={`${labelId}-kind ${labelId}-title`}')
    // what e2e tells a window from the drawer by
    expect(panel).toContain('data-testid="resource-drawer"')
    expect(drawerSrc).toContain('const labelId = useId()')
    expect(drawerSrc).toContain('labelId={labelId}')
  })

  it('names nothing without an id, as other callers of the header draw it', () => {
    const tree = ResourceDetailHeader({
      kind: 'Pod', displayKind: 'Pod', ns: 'shop', name: 'web-0', effectiveRawJson: null, canGoBack: false, canDelete: false,
      tab: 'info', onClose: vi.fn(), onGoBack: vi.fn(), onTabChange: vi.fn(), onDeleteClick: vi.fn(),
      t: as((_key: string, o: { defaultValue: string }) => o.defaultValue),
    })
    expect(elementsOf(tree, (props) => typeof props.id === 'string')).toEqual([])
  })
})

describe('Tab in the open drawer', () => {
  it('goes from its last control to its first and from its first to its last', () => {
    const s = scene()
    s.page.active = s.link
    const e = tabKey()
    keepTabIn(as(s.drawer), e, as(s.link))
    expect(e.preventDefault).toHaveBeenCalledOnce()
    expect(s.page.active).toBe(s.close)

    const back = tabKey(true)
    keepTabIn(as(s.drawer), back, as(s.close))
    expect(back.preventDefault).toHaveBeenCalledOnce()
    expect(s.page.active).toBe(s.link)
  })

  it('leaves the move between its controls to the browser', () => {
    const s = scene()
    for (const [from, shift] of [[s.info, false], [s.info, true], [s.del, false], [s.link, true]] as const) {
      const e = tabKey(shift)
      keepTabIn(as(s.drawer), e, as(from))
      expect(e.preventDefault, `${shift ? 'Shift+Tab' : 'Tab'} from ${from.name}`).not.toHaveBeenCalled()
    }
  })

  it('from the title it opened on: Tab to the next control, Shift+Tab round to the last, not to the page behind', () => {
    const s = scene()
    s.page.active = s.title
    const e = tabKey()
    keepTabIn(as(s.drawer), e, as(s.title))
    expect(e.preventDefault).not.toHaveBeenCalled()

    const back = tabKey(true)
    keepTabIn(as(s.drawer), back, as(s.title))
    expect(back.preventDefault).toHaveBeenCalledOnce()
    expect(s.page.active).toBe(s.link)
  })

  it('takes a focus from outside into it: the page, the body, the chat button', () => {
    for (const from of ['row', 'body', 'chatButton'] as const) {
      const s = scene()
      const active = from === 'body' ? null : s[from]
      const e = tabKey()
      keepTabIn(as(s.drawer), e, as(active))
      expect(s.page.active, `Tab from ${from}`).toBe(s.close)
      const back = tabKey(true)
      keepTabIn(as(s.drawer), back, as(active))
      expect(s.page.active, `Shift+Tab from ${from}`).toBe(s.link)
    }
  })

  it('counts only what shows: a hidden last control is skipped and the focus goes round', () => {
    const s = scene()
    s.link.shown = false
    const e = tabKey()
    keepTabIn(as(s.drawer), e, as(s.del))
    expect(e.preventDefault).toHaveBeenCalledOnce()
    expect(s.page.active).toBe(s.close)
  })

  it('leaves a Tab an editor took (Monaco indenting) alone', () => {
    const s = scene()
    s.page.active = s.link
    const e = tabKey(false, true)
    keepTabIn(as(s.drawer), e, as(s.link))
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(s.page.active).toBe(s.link)
  })
})

describe('the drawer\'s keys', () => {
  it('Escape closes it and goes no further; Tab stays in it; another key is not its own', () => {
    const s = scene()
    const close = vi.fn()
    const keys = drawerKeydown(() => as(s.drawer), () => true, close, docOf(s.page))
    s.page.active = s.link
    keys(tabKey())
    expect(s.page.active).toBe(s.close)

    const escape = keyOf('Escape')
    keys(escape)
    expect(close).toHaveBeenCalledOnce()
    expect(escape.stopPropagation).toHaveBeenCalledOnce()

    const other = keyOf('Enter')
    keys(other)
    expect(other.preventDefault).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('does nothing while a window is over it', () => {
    const s = scene()
    const close = vi.fn()
    const keys = drawerKeydown(() => as(s.drawer), () => false, close, docOf(s.page))
    s.page.active = s.link
    const tab = tabKey()
    keys(tab)
    const escape = keyOf('Escape')
    keys(escape)
    expect(tab.preventDefault).not.toHaveBeenCalled()
    expect(s.page.active).toBe(s.link)
    expect(close).not.toHaveBeenCalled()
    expect(escape.stopPropagation).not.toHaveBeenCalled()
  })

  it('is the listener the drawer adds on window while it is open, bubbling', () => {
    expect(drawerSrc).toContain('const onKeyDown = drawerKeydown(() => panelRef.current, isTopModal, () => handleCloseRef.current(), document)')
    expect(drawerSrc).toContain("window.addEventListener('keydown', onKeyDown)\n")
    expect(drawerSrc).toContain('useModalStackEntry(!!target)')
  })
})

// A Delete window over the drawer: ModalOverlay (on the document) and the drawer (on window) both hear the key.
describe('a window opened over the drawer', () => {
  let doc: ((e: unknown) => void)[]
  let win: ((e: unknown) => void)[]
  let s: ReturnType<typeof scene>
  let windowFirst: El
  let windowLast: El
  beforeEach(() => {
    doc = []
    win = []
    s = scene()
    const box = s.page.el('window', null)
    windowFirst = s.page.el('cancel', box, { tabbable: true })
    windowLast = s.page.el('confirm', box, { tabbable: true })
    ui.overlay = box
    s.page.active = s.del
    vi.stubGlobal('document', {
      body: null,
      get activeElement() { return s.page.active },
      addEventListener: (_type: string, fn: (e: unknown) => void) => doc.push(fn),
      removeEventListener: (_type: string, fn: (e: unknown) => void) => { doc = doc.filter((f) => f !== fn) },
    })
  })
  afterEach(() => { fakeUnmount(); vi.unstubAllGlobals() })

  // a key on its way up: the document's listeners, then window's, unless one stopped it
  const press = (e: ReturnType<typeof keyOf>) => {
    let stopped = false
    const stop = e.stopPropagation
    e.stopPropagation = vi.fn(() => { stopped = true; stop() })
    for (const target of [doc, win]) {
      if (stopped) break
      for (const fn of [...target]) fn(e)
    }
    return e
  }

  it('takes Tab and Escape; the drawer under it keeps its focus and stays open', () => {
    let top: 'window' | 'drawer' = 'window'
    const closeDrawer = vi.fn()
    win.push(drawerKeydown(() => as(s.drawer), () => top === 'drawer', closeDrawer, as(globalThis.document)) as (e: unknown) => void)
    const closeWindow = vi.fn()
    fakeRender(() => ModalOverlay({ children: as<ReactNode>(null), onClose: closeWindow }))
    expect(s.page.active, 'the window opens with the focus inside').toBe(windowFirst)

    s.page.active = windowLast
    press(tabKey())
    expect(s.page.active, 'Tab goes round the window, not the drawer').toBe(windowFirst)
    press(tabKey(true))
    expect(s.page.active).toBe(windowLast)

    press(keyOf('Escape'))
    expect(closeWindow).toHaveBeenCalledOnce()
    expect(closeDrawer, 'the Escape that closed the window does not close the drawer').not.toHaveBeenCalled()

    fakeUnmount()
    top = 'drawer'
    expect(s.page.active, 'the closed window gives the focus back to Delete').toBe(s.del)
    s.page.active = s.link
    press(tabKey())
    expect(s.page.active, 'with the window gone Tab goes round the drawer again').toBe(s.close)
  })
})

// The floating chat is not part of the drawer: it keeps its own Tab and Escape and is reached with its shortcut.
describe('the way to the floating chat from the drawer', () => {
  const shortcut = (over: Partial<KeyboardEvent> = {}) => {
    const e = { key: '/', code: 'Slash', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false,
      repeat: false, defaultPrevented: false, preventDefault: vi.fn(() => { e.defaultPrevented = true }), stopPropagation: vi.fn(), ...over }
    return e
  }

  it('⌘/ (Ctrl+/) opens the chat while the drawer is open, whichever window listener hears it first', () => {
    for (const drawerFirst of [true, false]) {
      const s = scene()
      s.page.active = s.info
      const close = vi.fn()
      const toggle = vi.fn()
      const listeners = [drawerKeydown(() => as(s.drawer), () => true, close, docOf(s.page)),
        chatShortcutKeydown(true, () => true, toggle)] as ((e: ReturnType<typeof shortcut>) => void)[]
      const e = shortcut()
      for (const fn of drawerFirst ? listeners : [...listeners].reverse()) fn(e)
      expect(toggle, `drawer first: ${drawerFirst}`).toHaveBeenCalledOnce()
      expect(close).not.toHaveBeenCalled()
      expect(s.page.active).toBe(s.info)
    }
  })

  it('Tab and Escape pressed in the chat window stay there while the drawer is open', () => {
    // the window's handler runs on React's root, before the document and window listeners, and stops both keys while
    // the modal stack, which holds the drawer, is not empty
    expect(chatPanelSrc).toMatch(/e\.key === 'Escape' && !e\.nativeEvent\.isComposing\) \{\s+e\.stopPropagation\(\)/)
    expect(chatPanelSrc).toMatch(/e\.key === 'Tab' && modalOpen\(\)\) \{\s+e\.stopPropagation\(\)/)
    expect(drawerSrc).not.toMatch(/addEventListener\('keydown', onKeyDown, (true|\{)/)
  })
})
