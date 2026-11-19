import { describe, expect, it, vi } from 'vitest'
import { elementsOf, fakeRender, fakeUnmount } from '@/testing/fakeHooks'
import { landOn, listOf, moveIn, returnFocus, rowOpening, useDrawerFocus } from './drawerFocus'
import { drawerObjectKey, namedByKey } from './crDetail'
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
  text = ''
  constructor(public page: Page, public tag: string, public parentElement: El | null, attrs: Record<string, string> = {}, public focusable = false) {
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v)
    page.all.push(this)
  }
  get children(): El[] {
    return this.page.all.filter((el) => el.parentElement === this && el.isConnected)
  }
  get textContent(): string {
    return this.text + this.children.map((el) => el.textContent).join('')
  }
  querySelectorAll(selector: string): El[] {
    return this.page.all.filter((el) => el !== this && el.isConnected && this.contains(el) && el.matches(selector))
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

// A row of a table inside the drawer opens another object in the same drawer (a ConfigMap's pod row opens the Pod), and
// Back shows the object before again, drawn anew. The focus goes to the next object's title, and on Back to the row
// that opens the object it left, as a closing drawer gives it back to the list's row.
describe('a drawer moved on by a row inside it', () => {
  const render = (s: ReturnType<typeof scene>, key: string) => fakeRender(() => useDrawerFocus(key, { current: as(s.panel) }, { current: as(s.title) }, docOf(s.page)))
  const key = (kind: string, name: string, namespace?: string) => drawerObjectKey({ kind, name, namespace })

  // one object's view in the drawer: a table whose rows have a cell per text
  function view(s: ReturnType<typeof scene>, rows: string[][]) {
    const box = new El(s.page, 'div', s.panel)
    const table = new El(s.page, 'table', box)
    const made = rows.map((cells) => {
      const row = new El(s.page, 'tr', table, { 'data-open-row': '', tabindex: '0' })
      for (const text of cells) Object.assign(new El(s.page, 'td', row), { text })
      return row
    })
    return { box, rows: made }
  }
  // Enter on a row: the drawer moves on and the view the row was in goes
  const press = (s: ReturnType<typeof scene>, row: El, box: El) => {
    row.focus()
    s.page.remove(box)
  }

  it('goes to the next object\'s title, on Back to that row of the object before, and as it closes to the page\'s row', () => {
    const s = scene()
    s.page.remove(s.back) // the first object has no Back
    s.row.focus()
    const configMap = key('ConfigMap', 'a', 'shop')
    render(s, configMap)
    expect(s.page.activeElement).toBe(s.title)

    const pods = view(s, [['web-0', 'Running', '5m'], ['web-1', 'Running', '5m']])
    press(s, pods.rows[1], pods.box)
    const pod = view(s, [])
    render(s, key('Pod', 'web-1', 'shop'))
    expect(s.page.activeElement).toBe(s.title)

    // the ConfigMap's rows are new elements, and their ages moved on
    s.page.remove(pod.box)
    const again = view(s, [['web-0', 'Running', '6m'], ['web-1', 'Running', '6m']])
    render(s, configMap)
    expect(s.page.activeElement).toBe(again.rows[1])

    // Escape, X or the backdrop close the drawer whatever object it shows
    s.page.remove(s.panel)
    fakeUnmount()
    expect(s.page.activeElement).toBe(s.row)
  })

  it('two objects deep, each Back finds the row of the object before, from the Back button too', () => {
    const s = scene()
    s.row.focus()
    const storageClass = key('StorageClass', 'fast')
    const claim = key('PersistentVolumeClaim', 'data', 'shop')
    render(s, storageClass)
    const claims = view(s, [['ops/data', 'Bound'], ['shop/data', 'Bound']])
    press(s, claims.rows[1], claims.box)
    render(s, claim)
    const pods = view(s, [['web-0', 'Running'], ['web-1', 'Running']])
    press(s, pods.rows[0], pods.box)
    render(s, key('Pod', 'web-0', 'shop'))
    expect(s.page.activeElement).toBe(s.title)

    // Back pressed on the Back button, which stays: the focus still goes to the row
    s.back.focus()
    const podsAgain = view(s, [['web-0', 'Running'], ['web-1', 'Running']])
    render(s, claim)
    expect(s.page.activeElement).toBe(podsAgain.rows[0])

    // Back again to the first object, where the Back button goes
    s.back.focus()
    s.page.remove(s.back)
    s.page.remove(podsAgain.box)
    const claimsAgain = view(s, [['ops/data', 'Bound'], ['shop/data', 'Bound']])
    render(s, storageClass)
    expect(s.page.activeElement).toBe(claimsAgain.rows[1])

    s.page.remove(s.panel)
    fakeUnmount()
    expect(s.page.activeElement).toBe(s.row)
  })

  it('a move that is not Back, to an object whose table has a row of the one before, goes to the title', () => {
    const s = scene()
    s.row.focus()
    render(s, key('Pod', 'web-1', 'shop'))
    // a link in the Pod's view opens its ConfigMap, whose pods table has this pod
    s.link.focus()
    s.page.remove(s.link)
    view(s, [['web-1', 'Running']])
    render(s, key('ConfigMap', 'a', 'shop'))
    expect(s.page.activeElement).toBe(s.title)
    fakeUnmount()
  })

  it('on Back to a view that does not show that row (another page, not read yet), the rule before holds', () => {
    const s = scene()
    s.page.remove(s.back)
    s.row.focus()
    const configMap = key('ConfigMap', 'a', 'shop')
    render(s, configMap)
    const pods = view(s, [['web-11', 'Running']])
    press(s, pods.rows[0], pods.box)
    render(s, key('Pod', 'web-11', 'shop'))
    view(s, [['web-0', 'Running']])
    render(s, configMap)
    expect(s.page.activeElement).toBe(s.title)
    fakeUnmount()
  })
})

describe('the row that opens the object Back left', () => {
  const s = scene()
  const table = new El(s.page, 'table', s.panel)
  const row = (...texts: string[]) => {
    const r = new El(s.page, 'tr', table, { 'data-open-row': '', tabindex: '0' })
    for (const text of texts) Object.assign(new El(s.page, 'td', r), { text })
    return r
  }
  const shop = row('shop', 'web-1')
  const ops = row('ops', 'web-1')
  // a StorageClass's PV row names its claim in a later cell, the claim's own row in its first
  const pv = row('pv-1', 'Bound', 'ops/data')
  const claim = row('ops/data', 'Bound')

  it('is the row with its name and namespace, the name\'s cell first, else one with its name, else none', () => {
    expect(rowOpening(as(s.panel), { namespace: 'ops', name: 'web-1' })).toBe(ops)
    expect(rowOpening(as(s.panel), { namespace: 'shop', name: 'web-1' })).toBe(shop)
    expect(rowOpening(as(s.panel), { namespace: 'ops', name: 'data' })).toBe(claim)
    expect(rowOpening(as(s.panel), { namespace: '', name: 'pv-1' })).toBe(pv)
    expect(rowOpening(as(s.panel), { namespace: 'other', name: 'web-1' })).toBe(shop)
    expect(rowOpening(as(s.panel), { namespace: 'shop', name: 'web' })).toBeNull()
    expect(rowOpening(null, { namespace: 'shop', name: 'web-1' })).toBeNull()
  })

  it('is looked for by the namespace and name the drawer\'s key holds', () => {
    expect(namedByKey(drawerObjectKey({ kind: 'Pod', namespace: 'shop', name: 'web-1' }))).toEqual({ namespace: 'shop', name: 'web-1' })
    expect(namedByKey(drawerObjectKey({ kind: 'PersistentVolume', name: 'pv-1' }))).toEqual({ namespace: '', name: 'pv-1' })
    expect(namedByKey('ConfigMap/shop/a')).toBeNull()
    expect(namedByKey('["Pod","shop",""]')).toBeNull()
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
