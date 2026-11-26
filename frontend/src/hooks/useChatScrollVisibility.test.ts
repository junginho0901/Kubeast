import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watchChatScroll } from './useChatScrollVisibility'
import { ToggleButton } from '@/components/FloatingAIChat/ToggleButton'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, options: { defaultValue: string }) => options.defaultValue }) }))
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function page() {
  const element = (scope = 'page', top = 0) => ({
    nodeType: 1, scrollTop: top, scrollHeight: 1800, clientHeight: 900, parentElement: null,
    closest: (selector: string) => selector.includes('floating-chat-panel') ? (scope === 'chat' ? {} : null) : (scope === 'sidebar' ? null : {}),
    querySelectorAll: () => [],
  })
  const viewport = element(), main = element(), inner = element('page', 120), sidebar = element('sidebar'), chat = element('chat')
  const doc = Object.assign(new EventTarget(), {
    scrollingElement: viewport,
    activeElement: null as unknown,
    querySelectorAll: () => [main],
  })
  const rect = { left: 1368, right: 1416, top: 828, bottom: 876 }
  const button = { contains: (el: unknown) => el === button, getBoundingClientRect: () => rect }
  const win = Object.assign(new EventTarget(), { innerWidth: 1440, innerHeight: 900, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout })
  const change = vi.fn()
  const start = () => watchChatScroll(doc as unknown as Document, win as unknown as Window, () => button as unknown as HTMLButtonElement, change)
  const fire = (type: string, target: unknown = doc, props = {}) => {
    const event = new Event(type)
    Object.defineProperty(event, 'target', { value: target })
    Object.assign(event, props)
    doc.dispatchEvent(event)
  }
  const scroll = (top: number, target = viewport) => {
    target.scrollTop = top
    fire('scroll', target === viewport ? doc : target)
  }
  return { doc, win, button, rect, viewport, inner, sidebar, chat, change, start, fire, scroll }
}

describe('the chat button while reading', () => {
  it('hides going down, comes back immediately going up, and emits only changes', () => {
    const p = page(), stop = p.start()
    p.scroll(20)
    p.scroll(40)
    expect(p.change.mock.calls).toEqual([[true]])
    p.scroll(39)
    expect(p.change.mock.calls).toEqual([[true], [false]])
    expect(vi.getTimerCount()).toBe(0)
    stop()
  })

  it('returns 500 ms after the latest downward movement, not the first one', () => {
    const p = page(), stop = p.start()
    p.scroll(20)
    vi.advanceTimersByTime(400)
    p.scroll(50)
    vi.advanceTimersByTime(499)
    expect(p.change).toHaveBeenLastCalledWith(true)
    vi.advanceTimersByTime(1)
    expect(p.change.mock.calls).toEqual([[true], [false]])
    stop()
  })

  it('stays visible when the pointer is in the 110 px corner and appears on approach', () => {
    const p = page(), stop = p.start()
    p.fire('pointermove', p.doc, { pointerType: 'mouse', clientX: 1330, clientY: 790 })
    p.scroll(10)
    expect(p.change).not.toHaveBeenCalled()
    p.fire('pointermove', p.doc, { pointerType: 'mouse', clientX: 1000, clientY: 600 })
    p.scroll(20)
    expect(p.change).toHaveBeenLastCalledWith(true)
    p.fire('pointermove', p.doc, { pointerType: 'mouse', clientX: 1430, clientY: 899 })
    expect(p.change).toHaveBeenLastCalledWith(false)
    stop()
  })

  it('also protects the button after the drawer moves it left', () => {
    const p = page(), stop = p.start()
    Object.assign(p.rect, { left: 636, right: 684 })
    p.fire('pointermove', p.doc, { pointerType: 'mouse', clientX: 640, clientY: 820 })
    p.scroll(30)
    expect(p.change).not.toHaveBeenCalled()
    stop()
  })

  it('reveals on keyboard focus and never hides while that focus stays', () => {
    const p = page(), stop = p.start()
    p.scroll(30)
    p.doc.activeElement = p.button
    p.fire('focusin', p.button)
    p.scroll(50)
    expect(p.change.mock.calls).toEqual([[true], [false]])
    stop()
  })

  it('does not hide a page without scroll room, or for sidebar and chat scrolls', () => {
    const p = page(), stop = p.start()
    p.viewport.scrollHeight = p.viewport.clientHeight
    p.scroll(1)
    p.scroll(20, p.sidebar)
    p.scroll(20, p.chat)
    expect(p.change).not.toHaveBeenCalled()
    stop()
  })

  it('reads an inner list before a wheel or key moves it, so its first upward move stays visible', () => {
    const p = page(), stop = p.start()
    p.fire('wheel', p.inner)
    p.scroll(110, p.inner)
    expect(p.change).not.toHaveBeenCalled()
    p.fire('keydown', p.inner)
    p.scroll(130, p.inner)
    expect(p.change).toHaveBeenLastCalledWith(true)
    stop()
  })

  it('does not treat an unknown programmatic jump or a touch in the corner as a mouse', () => {
    const p = page(), stop = p.start()
    p.scroll(600, p.inner)
    expect(p.change).not.toHaveBeenCalled()
    p.fire('pointermove', p.doc, { pointerType: 'touch', clientX: 1400, clientY: 850 })
    p.scroll(30)
    expect(p.change).toHaveBeenLastCalledWith(true)
    stop()
  })

  it('reveals on resize and cleans every timer and listener when the page or chat state changes', () => {
    const p = page()
    const added = vi.spyOn(p.doc, 'addEventListener'), removed = vi.spyOn(p.doc, 'removeEventListener')
    const stop = p.start()
    p.scroll(20)
    p.win.dispatchEvent(new Event('resize'))
    expect(p.change).toHaveBeenLastCalledWith(false)
    p.scroll(40)
    stop()
    expect(vi.getTimerCount()).toBe(0)
    expect(removed.mock.calls.map(([name, listener]) => [name, listener])).toEqual(added.mock.calls.map(([name, listener]) => [name, listener]))
    p.change.mockClear()
    p.scroll(80)
    p.fire('pointermove', p.doc, { pointerType: 'mouse', clientX: 1440, clientY: 900 })
    vi.advanceTimersByTime(1000)
    expect(p.change).not.toHaveBeenCalled()
  })

  it('keeps the reading-hidden button keyboard reachable with its name, shortcut and original dock position', () => {
    const html = renderToStaticMarkup(createElement(ToggleButton, { onClick: () => {}, visible: true, scrollHidden: true, docked: true }))
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('aria-hidden="false"')
    expect(html).toContain('aria-label="Open AI Chat"')
    expect(html).toContain('aria-keyshortcuts=')
    expect(html).toContain('min-[1348px]:right-[756px]')
    expect(html).toContain('focus:opacity-100')
    expect(html).toContain('motion-reduce:transition-none')
    const closed = renderToStaticMarkup(createElement(ToggleButton, { onClick: () => {}, visible: false, scrollHidden: false, docked: false }))
    expect(closed).toContain('tabindex="-1"')
    expect(closed).toContain('aria-hidden="true"')
  })
})
