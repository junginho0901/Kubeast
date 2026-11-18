import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FIT_LIMITS, type FitBox, watchFitRows } from './useAdaptiveRowsPerPage'

// A list's Fit row count is the rows that end inside the table's box, each at its own height, once rows show: turning
// pages (rows or a header of other heights) keeps it, so a page starts where the one before ended. The box or the
// window changing size works it out again.

type Box = 'content-box' | 'border-box'

class FakeResizeObserver {
  static all: FakeResizeObserver[] = []
  targets: { el: object; box: Box }[] = []
  constructor(private readonly callback: (entries: { target: object }[]) => void) {
    FakeResizeObserver.all.push(this)
  }
  observe(el: object, options?: { box?: Box }) {
    this.targets.push({ el, box: options?.box ?? 'content-box' })
  }
  unobserve(el: object) {
    this.targets = this.targets.filter((t) => t.el !== el)
  }
  disconnect() {
    this.targets = []
  }
  // what changed on el: both boxes, or only the content box (a scrollbar taking room inside the border)
  static resize(el: object, changed: 'both' | 'content-box' = 'both') {
    for (const o of FakeResizeObserver.all) {
      if (o.targets.some((t) => t.el === el && (changed === 'both' || t.box === changed))) o.callback([{ target: el }])
    }
  }
}

let frames: (() => void)[] = []
const flushFrames = () => {
  const run = frames
  frames = []
  for (const f of run) f()
}
let resizeListeners: (() => void)[] = []

beforeEach(() => {
  FakeResizeObserver.all = []
  frames = []
  resizeListeners = []
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.stubGlobal('requestAnimationFrame', (f: () => void) => frames.push(f))
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  vi.stubGlobal('window', {
    innerHeight: 900,
    addEventListener: (_: string, f: () => void) => resizeListeners.push(f),
    removeEventListener: (_: string, f: () => void) => (resizeListeners = resizeListeners.filter((l) => l !== f)),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// the hook's own limits: the estimate of 46 px a row, at least one row and at most 50
const LIMITS = FIT_LIMITS
const TOP = 100 // where the box starts on the page

interface FakeRow {
  offsetHeight: number
  nextElementSibling: FakeRow | null
  getBoundingClientRect(): { top: number; bottom: number; height: number }
}

// A table box of 440 px (scroll box, header and rows inside it) with a header of 36 px and, under it, rows of the
// heights given: what a page draws. `draw` puts other rows in (a new page, more rows of the same page).
function table(heights: number[] | null, size: { box?: number; header?: number } = {}) {
  const tableEl = { offsetHeight: 0 }
  const body = {
    clientHeight: size.box ?? 440,
    clientTop: 0,
    scrollTop: 0,
    firstElementChild: tableEl,
    getBoundingClientRect: () => ({ top: TOP }),
  }
  const thead = { offsetHeight: size.header ?? 36 }
  const rowsOf = (hs: number[]): FakeRow | null => {
    const rows: FakeRow[] = hs.map((h, i) => ({
      offsetHeight: Math.round(h),
      nextElementSibling: null,
      getBoundingClientRect: () => {
        const top = TOP - body.scrollTop + thead.offsetHeight + hs.slice(0, i).reduce((a, b) => a + b, 0)
        return { top, bottom: top + h, height: h }
      },
    }))
    rows.forEach((r, i) => { r.nextElementSibling = rows[i + 1] ?? null })
    return rows[0] ?? null
  }
  const box = { container: { clientHeight: 520 }, body, thead, row: heights === null ? null : rowsOf(heights) }
  const counts: number[] = []
  // what the page draws: a count that changes it starts a render
  let drawn = 12
  const watch = watchFitRows(() => box as unknown as FitBox, LIMITS, (n) => {
    counts.push(n)
    const changed = n !== drawn
    drawn = n
    return changed
  })
  const draw = (hs: number[]) => { box.row = rowsOf(hs) }
  return { box, tableEl, counts, draw, last: () => counts[counts.length - 1], watch }
}

const rowsOfHeight = (h: number, n = 12) => Array.from({ length: n }, () => h)

describe('watchFitRows: the Fit row count', () => {
  it('fits the rows drawn into the box', () => {
    const t = table(rowsOfHeight(60))
    expect(t.last()).toBe(6) // 36 + 6 × 60 = 396 ≤ 440, the seventh ends at 456
  })

  it('counts only the rows that end inside the box, each at its own height (the Alerts inbox at 1440×900)', () => {
    // rows of the first page as the inbox draws them: names and summaries wrap, so they differ
    const t = table([100.5, 85, 101, 101, 100.5, 85, 101, 85, 100.5], { box: 481, header: 64 })
    expect(t.last()).toBe(4) // 64 + 387.5 = 451.5 ≤ 481; the fifth ends at 552
  })

  it('does not count taller rows after a short first one as fitting', () => {
    const t = table([45, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90])
    expect(t.last()).toBe(4) // 36 + 45 + 3 × 90 = 351; the fifth ends at 441
  })

  it('takes rows past the last one drawn at the tallest height drawn, then measures them in the render that draws them', () => {
    const t = table([40, 50, 40])
    expect(t.last()).toBe(8) // 166 drawn, 274 px left: five more at 50 px
    t.draw([40, 50, 40, 40, 40, 120, 40, 40])
    t.watch.check()
    expect(t.last()).toBe(7) // the eighth ends at 446
    t.draw(rowsOfHeight(90, 7)) // the next page
    t.watch.check()
    expect(t.counts).toEqual([8, 7])
  })

  it('measures a list shorter than the box once more, then keeps its count', () => {
    const t = table([60, 60, 60])
    expect(t.last()).toBe(6) // 216 drawn, 224 px left: three more at 60 px
    t.watch.check() // the render of that count draws the same three rows
    expect(t.last()).toBe(6)
    t.draw([90, 90, 90, 90]) // a row more and taller rows come later
    t.watch.check()
    expect(t.counts).toEqual([6, 6])
  })

  it('counts from the drawn rows before the paint once rows come after a count made from the estimate', () => {
    const t = table(null)
    expect(t.last()).toBe(8) // (440 - 36) / 46, the estimate
    t.draw(rowsOfHeight(60, 8))
    t.watch.check()
    expect(t.last()).toBe(6)
  })

  it('reads a box scrolled down from its top', () => {
    const t = table(rowsOfHeight(60))
    t.box.body.scrollTop = 100
    t.box.body.clientHeight = 600
    FakeResizeObserver.resize(t.box.body)
    flushFrames()
    expect(t.last()).toBe(9) // 36 + 9 × 60 = 576 ≤ 600
  })

  it('keeps the count when the next page puts a taller first row in the same row element', () => {
    const t = table(rowsOfHeight(60))
    t.box.row!.getBoundingClientRect = () => ({ top: TOP + 36, bottom: TOP + 36 + 81, height: 81 })
    FakeResizeObserver.resize(t.box.row!)
    flushFrames()
    t.watch.check()
    expect(t.last()).toBe(6)
  })

  it('keeps the count when the next page brings rows of their own', () => {
    const t = table(rowsOfHeight(60))
    const before = t.box.row!
    t.draw(rowsOfHeight(81, 6))
    before.offsetHeight = 0 // the row of the page before left the table
    FakeResizeObserver.resize(before)
    FakeResizeObserver.resize(t.tableEl)
    flushFrames()
    t.watch.check()
    expect(t.last()).toBe(6)
  })

  it('keeps the count when a header wraps to another height on the next page', () => {
    const t = table(rowsOfHeight(67))
    expect(t.last()).toBe(6) // 36 + 6 × 67 = 438
    t.box.thead.offsetHeight = 56
    FakeResizeObserver.resize(t.box.thead)
    flushFrames()
    expect(t.last()).toBe(6)
  })

  it('keeps the count when a scrollbar shows under a wider page', () => {
    const t = table(rowsOfHeight(67))
    t.box.body.clientHeight = 425 // the scrollbar takes its room inside the box, the box keeps its size
    FakeResizeObserver.resize(t.box.body, 'content-box')
    flushFrames()
    expect(t.last()).toBe(6)
  })

  it('counts again when the box itself changes size', () => {
    const t = table(rowsOfHeight(60))
    t.box.body.clientHeight = 600
    FakeResizeObserver.resize(t.box.body)
    flushFrames()
    expect(t.last()).toBe(9) // 36 + 9 × 60 = 576
  })

  it('counts again when the window changes size, to fewer than five rows when only those fit', () => {
    const t = table(rowsOfHeight(60))
    t.box.body.clientHeight = 300
    for (const l of resizeListeners) l()
    flushFrames()
    expect(t.last()).toBe(4) // 36 + 4 × 60 = 276; the fifth would end at 336
  })

  it('counts again from the drawn rows when rows come after a count made from the estimate', () => {
    const t = table(null)
    expect(t.last()).toBe(8)
    t.draw(rowsOfHeight(60, 8))
    t.tableEl.offsetHeight = 400
    FakeResizeObserver.resize(t.tableEl)
    flushFrames()
    expect(t.last()).toBe(6)
  })

  it('stops watching when stopped', () => {
    const t = table(rowsOfHeight(60))
    t.watch.stop()
    t.box.body.clientHeight = 600
    FakeResizeObserver.resize(t.box.body)
    for (const l of resizeListeners) l()
    flushFrames()
    expect(t.counts).toEqual([6])
  })
})
