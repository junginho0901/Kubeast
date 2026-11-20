import { afterEach, describe, expect, it, vi } from 'vitest'
import { elementsOf, fakeRender, fakeUnmount } from '@/testing/fakeHooks'

// The floating chat sits over every window and the detail drawer, and Escape and Tab pressed in it stay in it while one
// is open (CLAUDE.md). The panel's own key handler meets a page in document order here, and a Tab it lets through moves
// as the browser's does: to the next control in that order, or out of the page past the first or the last.

const layer = vi.hoisted(() => ({ open: true }))
vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), ...(await import('@/testing/fakeHooks')).fakeHooks }))
vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string, o?: { defaultValue?: string }) => o?.defaultValue ?? key }),
}))
vi.mock('@tanstack/react-query', async (original) => ({
  ...(await original<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: () => ({ data: undefined, error: null }),
  useMutation: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
}))
vi.mock('@/hooks/useStickToBottom', () => ({ useStickToBottom: () => ({ ref: { current: null }, atBottom: true, scrollToBottom: vi.fn() }) }))
vi.mock('@/hooks/useEarlierMessages', () => ({ useEarlierMessages: () => ({ loading: false, error: null, load: vi.fn() }) }))
vi.mock('@/hooks/useModalStack', async (original) => ({ ...(await original<typeof import('@/hooks/useModalStack')>()), modalOpen: () => layer.open }))

import { ChatPanel } from './ChatPanel'

class Page {
  order: El[] = []
  active: El | null = null
  el(name: string, parent: El | null, how: { tabbable?: boolean; focusable?: boolean } = {}) {
    return new El(this, name, parent, how.tabbable ?? false, how.focusable ?? how.tabbable ?? false)
  }
  // the browser's move for a Tab no handler kept
  tab(shiftKey: boolean) {
    const at = this.active ? this.order.indexOf(this.active) : shiftKey ? this.order.length : -1
    const tabbable = this.order.filter((el) => el.tabbable)
    this.active = (shiftKey ? tabbable.filter((el) => this.order.indexOf(el) < at).pop() : tabbable.find((el) => this.order.indexOf(el) > at)) ?? null
  }
}

class El {
  isConnected = true
  constructor(public page: Page, public name: string, public parent: El | null, public tabbable: boolean, public focusable: boolean) {
    page.order.push(this)
  }
  focus() { if (this.focusable) this.page.active = this }
  contains(node: unknown): boolean {
    for (let el = node as El | null; el; el = el.parent) if (el === this) return true
    return false
  }
  compareDocumentPosition(other: El): number {
    let at = this.page.order.indexOf(other) > this.page.order.indexOf(this) ? 4 : 2
    if (this.contains(other)) at |= 16
    if (other.contains(this)) at |= 8
    return at
  }
  querySelectorAll() { return this.page.order.filter((el) => el !== this && this.contains(el) && el.tabbable) }
  getClientRects() { return [{}] }
}

// The page as Layout draws it: the drawer, the chat's button (out of the Tab order while the chat is open) and its panel
// (out of the Tab order too, but a press on its text puts the focus there), the sidebar and the page, and a window in a
// portal at the end of the body.
function scene(under: 'window' | 'drawer' | 'nothing') {
  const page = new Page()
  if (under === 'drawer') {
    const drawer = page.el('drawer', null)
    page.el('drawer title', drawer, { focusable: true })
    page.el('drawer close', drawer, { tabbable: true })
    page.el('drawer link', drawer, { tabbable: true })
  }
  page.el('chat button', null, { focusable: true })
  const panel = page.el('chat panel', null, { focusable: true })
  const close = page.el('chat close', panel, { tabbable: true })
  const question = page.el('suggested question', panel, { tabbable: true })
  const input = page.el('chat input', panel, { tabbable: true })
  const send = page.el('send', panel, { tabbable: true })
  page.el('sidebar link', null, { tabbable: true })
  page.el('row', null, { tabbable: true })
  if (under === 'window') {
    const box = page.el('window', null)
    page.el('window title', box, { focusable: true })
    page.el('cancel', box, { tabbable: true })
    page.el('confirm', box, { tabbable: true })
  }
  layer.open = under !== 'nothing'
  return { page, panel, close, question, input, send }
}

type Scene = ReturnType<typeof scene>

// the panel drawn as it is open, and the handler on its box
function keysOf(s: Scene, onClose = vi.fn()) {
  vi.stubGlobal('document', { get activeElement() { return s.page.active } })
  const tree = fakeRender(() => ChatPanel({
    onClose, getSnapshot: () => ({}) as never, consumeContextChanged: () => false, visible: true, docked: false,
    sessionId: null, onSessionIdChange: () => {},
  }))
  const [box] = elementsOf(tree, (props) => props['data-testid'] === 'floating-chat-panel')
  const handler = box.props.onKeyDown as (e: unknown) => void
  return (key: string, { shiftKey = false, isComposing = false } = {}) => {
    const e = { key, shiftKey, currentTarget: s.panel, nativeEvent: { isComposing }, defaultPrevented: false,
      preventDefault: vi.fn(() => { e.defaultPrevented = true }), stopPropagation: vi.fn() }
    handler(e)
    if (key === 'Tab' && !e.defaultPrevented) s.page.tab(shiftKey)
    return e
  }
}

const at = (s: Scene) => s.page.active?.name ?? 'out of the page'

afterEach(() => {
  fakeUnmount()
  vi.unstubAllGlobals()
  layer.open = true
})

describe('Tab in the floating chat while a window or the drawer is open under it', () => {
  for (const under of ['window', 'drawer'] as const) {
    it(`over a ${under}: from the panel itself Shift+Tab goes round to its last control and Tab to its first`, () => {
      const s = scene(under)
      const press = keysOf(s)
      s.page.active = s.panel
      const back = press('Tab', { shiftKey: true })
      expect(back.stopPropagation, `the ${under} under it does not hear it`).toHaveBeenCalledOnce()
      expect(at(s), `Shift+Tab from the panel over a ${under}`).toBe('send')

      s.page.active = s.panel
      press('Tab')
      expect(at(s), `Tab from the panel over a ${under}`).toBe('chat close')
    })

    it(`over a ${under}: from its last control round to its first and back, the moves between them the browser's`, () => {
      const s = scene(under)
      const press = keysOf(s)
      s.page.active = s.send
      expect(press('Tab').stopPropagation).toHaveBeenCalledOnce()
      expect(at(s), 'Tab from the last control').toBe('chat close')
      press('Tab', { shiftKey: true })
      expect(at(s), 'Shift+Tab from the first control').toBe('send')

      for (const [from, shiftKey, to] of [[s.question, false, 'chat input'], [s.input, true, 'suggested question']] as const) {
        s.page.active = from
        expect(press('Tab', { shiftKey }).preventDefault, `${shiftKey ? 'Shift+Tab' : 'Tab'} from ${from.name}`).not.toHaveBeenCalled()
        expect(at(s)).toBe(to)
      }
    })
  }

  it('with nothing open under it, Tab is the page\'s', () => {
    const s = scene('nothing')
    const press = keysOf(s)
    s.page.active = s.send
    const e = press('Tab')
    expect(e.stopPropagation).not.toHaveBeenCalled()
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(at(s)).toBe('sidebar link')
  })
})

describe('Escape in the floating chat', () => {
  it('closes only the chat; once it has, the next Escape goes on to the window under it', () => {
    const s = scene('window')
    const onClose = vi.fn()
    const press = keysOf(s, onClose)
    s.page.active = s.input
    expect(press('Escape').stopPropagation).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
    expect(press('Escape').stopPropagation).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('an Escape that ends a composition is the input method\'s', () => {
    const s = scene('drawer')
    const onClose = vi.fn()
    const press = keysOf(s, onClose)
    s.page.active = s.input
    expect(press('Escape', { isComposing: true }).stopPropagation).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})
