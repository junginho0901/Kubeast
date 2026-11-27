import { describe, expect, it, vi } from 'vitest'
import { elementsOf, fakeRender, fakeUnmount } from '@/testing/fakeHooks'
import { landOn, listOf, moveIn, returnFocus, useDrawerFocus } from './drawerFocus'
import { ResourceDetailHeader } from './ResourceDetailHeader'
import drawerSrc from '../ResourceDetailDrawer.tsx?raw'

vi.mock('react', async (importOriginal) => ({ ...(await importOriginal<typeof import('react')>()), ...(await import('@/testing/fakeHooks')).fakeHooks }))

// The drawer left the focus where it was as it opened (on the row, behind the backdrop) and dropped it to the page as
// it closed (WCAG 2.2 2.4.3). It now moves to the drawer's title and goes back to the row, or to its list.

// A page of elements as the browser keeps them: one focus, which falls to the body when its element is removed.
class Page {
  body: El
  activeElement: El
  all: El[] = []
  constructor() {
    this.body = new El(this, 'body', null)
    this.activeElement = this.body
  }
  querySelector(selector: string) {
    return this.all.find((el) => el.isConnected && el.matches(selector)) ?? null
  }
  remove(el: El) {
    for (const e of this.all) if (el.contains(e)) e.isConnected = false
    if (!this.activeElement.isConnected) this.activeElement = this.body
  }
}

class El {
  isConnected = true
  attrs = new Map<string, string>()
  blurs: (() => void)[] = []
  focus = vi.fn((_options?: FocusOptions) => {
    if (this.attrs.has('tabindex') || this.focusable) {
      const before = this.page.activeElement
      this.page.activeElement = this
      if (before !== this) before.blurs.splice(0).forEach((fn) => fn())
    }
  })
  constructor(public page: Page, public tag: string, public parentElement: El | null, attrs: Record<string, string> = {}, public focusable = false) {
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v)
    page.all.push(this)
  }
  matches(selector: string): boolean {
    return selector.split(',').map((s) => s.trim()).some((s) => (s.startsWith('[') ? this.attrs.has(s.slice(1, -1)) : this.tag === s))
  }
  closest(selector: string): El | null {
    return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null
  }
  contains(node: unknown): boolean {
    for (let el = node as El | null; el; el = el.parentElement) if (el === this) return true
    return false
  }
  hasAttribute(name: string) { return this.attrs.has(name) }
  setAttribute(name: string, value: string) { this.attrs.set(name, value) }
  removeAttribute(name: string) { this.attrs.delete(name) }
  addEventListener(type: string, fn: () => void) { if (type === 'blur') this.blurs.push(fn) }
}

// a list page with a table of two rows (the first with a button inside) and an open drawer
function scene() {
  const page = new Page()
  const main = new El(page, 'main', page.body)
  const table = new El(page, 'table', main)
  const row = new El(page, 'tr', table, { 'data-open-row': '', tabindex: '0' })
  const inner = new El(page, 'button', row, {}, true)
  const row2 = new El(page, 'tr', table, { 'data-open-row': '', tabindex: '0' })
  const panel = new El(page, 'div', page.body)
  const title = new El(page, 'h2', panel, { tabindex: '-1' })
  const back = new El(page, 'button', panel, {}, true)
  const link = new El(page, 'button', panel, {}, true)
  const chat = new El(page, 'textarea', page.body, {}, true)
  return { page, main, table, row, inner, row2, panel, title, back, link, chat }
}
const as = <T,>(el: El) => el as unknown as T
const docOf = (page: Page) => page as unknown as Parameters<typeof returnFocus>[0]

describe('the list a row is in', () => {
  it('is its table for a row or a control inside it, and none for what is not in a row', () => {
    const { table, row, inner, back } = scene()
    expect(listOf(as(row))).toBe(table)
    expect(listOf(as(inner))).toBe(table)
    expect(listOf(as(back))).toBeNull()
    expect(listOf(null)).toBeNull()
  })

  it('is the box marked as a list for a box row, else the row\'s parent', () => {
    const page = new Page()
    const list = new El(page, 'div', page.body, { 'data-list': 'GPU nodes' })
    const box = new El(page, 'div', list, { 'data-open-row': '', role: 'button' })
    const plain = new El(page, 'div', page.body)
    const box2 = new El(page, 'div', plain, { 'data-open-row': '' })
    expect(listOf(as(box))).toBe(list)
    expect(listOf(as(box2))).toBe(plain)
  })
})

describe('as the drawer opens', () => {
  it('the focus leaves the row for the drawer\'s title, without scrolling', () => {
    const { page, row, panel, title } = scene()
    row.focus()
    expect(moveIn(docOf(page), as(panel), as(title))).toBe('title')
    expect(page.activeElement).toBe(title)
    expect(title.focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('a control inside the drawer that has the focus keeps it', () => {
    const { page, panel, title, back } = scene()
    back.focus()
    expect(moveIn(docOf(page), as(panel), as(title))).toBe('stay')
    expect(page.activeElement).toBe(back)
  })
})

describe('as the drawer closes', () => {
  it('the focus goes back to the row that opened it (Escape, X or the backdrop: the drawer is gone)', () => {
    const { page, row, table, panel, title } = scene()
    title.focus()
    page.remove(panel)
    expect(returnFocus(docOf(page), as(row), as(table), 'opener')).toBe('origin')
    expect(page.activeElement).toBe(row)
  })

  it('to the head of the list when the row has gone, for as long as the list keeps the focus', () => {
    const { page, row, row2, table, panel, title } = scene()
    title.focus()
    page.remove(panel)
    page.remove(row)
    expect(returnFocus(docOf(page), as(row), as(table), 'opener')).toBe('list')
    expect(page.activeElement).toBe(table)
    expect(table.attrs.get('tabindex')).toBe('-1')
    expect(table.hasAttribute('data-focus-landing')).toBe(true)
    row2.focus()
    expect(table.hasAttribute('tabindex')).toBe(false)
    expect(table.hasAttribute('data-focus-landing')).toBe(false)
  })

  it('to the list after a delete of the object the row opened, before the list drops the row', () => {
    const { page, row, table, panel } = scene()
    page.remove(panel)
    expect(returnFocus(docOf(page), as(row), as(table), 'list')).toBe('list')
    expect(page.activeElement).toBe(table)
  })

  it('to the page\'s list when the drawer was opened from the address', () => {
    const { page, table, panel } = scene()
    page.remove(panel)
    expect(returnFocus(docOf(page), null, null, 'opener')).toBe('list')
    expect(page.activeElement).toBe(table)
  })

  it('nowhere new when what opened it is gone and was in no list', () => {
    const { page, back, panel } = scene()
    page.remove(panel)
    expect(returnFocus(docOf(page), as(back), null, 'opener')).toBe('none')
    expect(page.activeElement).toBe(page.body)
  })

  it('a focus put outside the drawer meanwhile stays (the floating chat)', () => {
    const { page, row, table, panel, chat } = scene()
    chat.focus()
    page.remove(panel)
    expect(returnFocus(docOf(page), as(row), as(table), 'opener')).toBe('stay')
    expect(page.activeElement).toBe(chat)
  })

  it('a list that already takes the focus is focused as it is', () => {
    const page = new Page()
    const list = new El(page, 'table', page.body, { tabindex: '0' })
    landOn(as(list))
    expect(page.activeElement).toBe(list)
    expect(list.hasAttribute('data-focus-landing')).toBe(false)
  })
})

describe('the drawer\'s focus as it renders', () => {
  const render = (s: ReturnType<typeof scene>, key: string) => fakeRender(() => useDrawerFocus(key, { current: as(s.panel) }, { current: as(s.title) }, docOf(s.page)))

  it('opens on the title, follows the next object, and goes back to the row as it closes', () => {
    const s = scene()
    s.row.focus()
    render(s, 'ConfigMap/shop/a')
    expect(s.page.activeElement).toBe(s.title)

    // a link inside the drawer opened another object and went with the view it was in
    s.link.focus()
    s.page.remove(s.link)
    render(s, 'Pod/shop/b')
    expect(s.page.activeElement).toBe(s.title)

    // Back, still there, keeps the focus as the drawer moves
    s.back.focus()
    render(s, 'ConfigMap/shop/a')
    expect(s.page.activeElement).toBe(s.back)

    s.page.remove(s.panel)
    fakeUnmount()
    expect(s.page.activeElement).toBe(s.row)
  })

  it('goes to the list when the drawer closes on a delete of its first object', () => {
    const s = scene()
    s.row.focus()
    const deleted = render(s, 'ConfigMap/shop/a')
    deleted()
    s.page.remove(s.panel)
    fakeUnmount()
    expect(s.page.activeElement).toBe(s.table)
  })

  it('reads no document on a render without one', () => {
    expect(() => fakeRender(() => useDrawerFocus('ConfigMap/shop/a', { current: null }, { current: null }, null))).not.toThrow()
    fakeUnmount()
  })
})

describe('the drawer', () => {
  it('gives its title the ref and a place outside the Tab order, and itself the panel and the delete to the hook', () => {
    const titleRef = { current: null }
    const tree = ResourceDetailHeader({
      kind: 'ConfigMap', displayKind: 'ConfigMap', ns: 'shop', name: 'a', effectiveRawJson: {}, canGoBack: false, canDelete: false,
      tab: 'info', titleRef, onClose: () => {}, onGoBack: () => {}, onTabChange: () => {}, onDeleteClick: () => {}, t: ((k: string) => k) as never,
    })
    const [title] = elementsOf(tree, (_props, type) => type === 'h2')
    expect(title.props.ref).toBe(titleRef)
    expect(title.props.tabIndex).toBe(-1)
    expect(drawerSrc).toContain('useDrawerFocus(objectId, panelRef, titleRef)')
    expect(drawerSrc).toContain('ref={panelRef}')
    expect(drawerSrc).toContain('titleRef={titleRef}')
    expect(drawerSrc).toMatch(/if \(!canGoBack\) focusListOnClose\(\)\s+close\(\)/)
  })
})
