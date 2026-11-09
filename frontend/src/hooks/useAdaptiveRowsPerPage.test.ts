import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type FitBox, watchFitRows } from './useAdaptiveRowsPerPage'

// A list's Fit row count is one number once rows show: turning pages (a first row or a header of another height) keeps
// it, so a page starts where the one before ended. The box or the window changing size works it out again.

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

const LIMITS = { rowHeight: 46, headerHeight: 44, footerHeight: 92, minRows: 5, maxRows: 50 }

// a table box of 440 px with a header of 36 px; the first row's height as the test says
function table(rowHeight: number | null) {
  const tableEl = { offsetHeight: 0 }
  const box = {
    container: { clientHeight: 520 },
    body: { clientHeight: 440, firstElementChild: tableEl },
    thead: { offsetHeight: 36 },
    row: rowHeight === null ? null : { offsetHeight: rowHeight },
  }
  const counts: number[] = []
  const stop = watchFitRows(() => box as unknown as FitBox, LIMITS, (n) => counts.push(n))
  return { box, tableEl, counts, last: () => counts[counts.length - 1], stop }
}

describe('watchFitRows: the Fit row count', () => {
  it('fits the rows of the first row height into the box', () => {
    const t = table(60)
    expect(t.last()).toBe(6) // (440 - 36) / 60
  })

  it('keeps the count when the next page puts a taller first row in the same row element', () => {
    const t = table(60)
    t.box.row!.offsetHeight = 81
    FakeResizeObserver.resize(t.box.row!)
    flushFrames()
    expect(t.last()).toBe(6)
  })

  it('keeps the count when the next page brings a first row of its own', () => {
    const t = table(60)
    const before = t.box.row!
    t.box.row = { offsetHeight: 81 }
    before.offsetHeight = 0 // the row of the page before left the table
    FakeResizeObserver.resize(before)
    FakeResizeObserver.resize(t.tableEl)
    flushFrames()
    expect(t.last()).toBe(6)
  })

  it('keeps the count when a header wraps to another height on the next page', () => {
    const t = table(67)
    expect(t.last()).toBe(6) // (440 - 36) / 67
    t.box.thead.offsetHeight = 56
    FakeResizeObserver.resize(t.box.thead)
    flushFrames()
    expect(t.last()).toBe(6)
  })

  it('keeps the count when a scrollbar shows under a wider page', () => {
    const t = table(67)
    t.box.body.clientHeight = 425 // the scrollbar takes its room inside the box, the box keeps its size
    FakeResizeObserver.resize(t.box.body, 'content-box')
    flushFrames()
    expect(t.last()).toBe(6)
  })

  it('counts again when the box itself changes size', () => {
    const t = table(60)
    t.box.body.clientHeight = 600
    FakeResizeObserver.resize(t.box.body)
    flushFrames()
    expect(t.last()).toBe(9) // (600 - 36) / 60
  })

  it('counts again when the window changes size', () => {
    const t = table(60)
    t.box.body.clientHeight = 300
    for (const l of resizeListeners) l()
    flushFrames()
    expect(t.last()).toBe(5) // (300 - 36) / 60 = 4, held to the five rows at least
  })

  it('counts from the first row once rows come after a count made from the estimate', () => {
    const t = table(null)
    expect(t.last()).toBe(8) // (440 - 36) / 46, the estimate
    t.box.row = { offsetHeight: 60 }
    t.tableEl.offsetHeight = 400
    FakeResizeObserver.resize(t.tableEl)
    flushFrames()
    expect(t.last()).toBe(6)
  })

  it('stops watching when stopped', () => {
    const t = table(60)
    t.stop()
    t.box.body.clientHeight = 600
    FakeResizeObserver.resize(t.box.body)
    for (const l of resizeListeners) l()
    flushFrames()
    expect(t.counts).toEqual([6])
  })
})
