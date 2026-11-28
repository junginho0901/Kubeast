import { describe, it, expect } from 'vitest'
import i18n from '@/i18n'
import { DOT_SHAPE_MIN, GAP, crossWidth, dotShape, focusSpokenCell, layoutMap, mapKey, mapNodeCount, mapSpeech, pointerFocusAfter, spokenAfter, traceDot, type MapPointerEvent } from './nodeMapLayout'
import type { NodeEntry } from './hooks/useClusterDerived'

const nodes = (n: number, pods: (i: number) => number): NodeEntry[] =>
  Array.from({ length: n }, (_, i) => ({ node: `n${i}`, label: `n${i}`, counts: { node: `n${i}`, total: pods(i), ok: pods(i), warn: 0, error: 0 } }))

describe('node map layout', () => {
  it('every pod of the busiest node has a dot inside its cell', () => {
    for (const [n, max] of [[1, 30], [3, 110], [1000, 110], [1000, 250], [200, 5]] as const) {
      const entries = nodes(n, (i) => (i === n - 1 ? max : 3))
      for (const width of [600, 1100, 1800]) {
        const l = layoutMap(width, entries)
        expect(l.per * l.per, `${n} nodes, ${max} pods, ${width}px`).toBeGreaterThanOrEqual(max)
        expect(l.per * l.dot + 4, `${n} nodes, ${max} pods, ${width}px`).toBeLessThanOrEqual(l.cell)
      }
    }
  })

  it('all the cells fit the width, and the height holds every row', () => {
    const entries = nodes(1001, () => 50)
    const l = layoutMap(1100, entries)
    expect(l.cols * (l.cell + GAP) - GAP).toBeLessThanOrEqual(1100)
    expect(l.height).toBe(Math.ceil(1001 / l.cols) * (l.cell + GAP) - GAP)
  })

  it('a small cluster gets large cells, a large one small cells', () => {
    expect(layoutMap(1100, nodes(2, () => 20)).cell).toBe(48)
    expect(layoutMap(1100, nodes(1000, () => 20)).cell).toBeLessThan(20)
  })
})

describe('the node map from the keyboard', () => {
  it('moves along the cells with the arrows, stopping at the ends, and opens the cell reached with Enter or Space', () => {
    // 25 cells in rows of 10
    expect(mapKey('ArrowRight', null, 25, 10)).toEqual({ hover: 1, end: false })
    expect(mapKey('ArrowDown', 3, 25, 10)).toEqual({ hover: 13, end: false })
    expect(mapKey('ArrowDown', 18, 25, 10)).toEqual({ hover: 24, end: false })
    expect(mapKey('ArrowUp', 4, 25, 10)).toEqual({ hover: 0, end: false })
    expect(mapKey('ArrowLeft', 0, 25, 10)).toEqual({ hover: 0, end: true })
    expect(mapKey('Enter', 13, 25, 10)).toEqual({ open: 13 })
    expect(mapKey(' ', null, 25, 10)).toEqual({ open: 0 })
    expect([mapKey('Tab', 3, 25, 10), mapKey('a', 3, 25, 10), mapKey('constructor', 3, 25, 10)]).toEqual([null, null, null])
  })

  it('opens the last cell, never one past it, when the cells became fewer under the cell reached', () => {
    // the 25th cell reached, then the map down to 3 cells (its pods gone, a search narrowed)
    expect(mapKey('Enter', 24, 3, 10)).toEqual({ open: 2 })
    expect(mapKey('ArrowLeft', 24, 3, 10)).toEqual({ hover: 1, end: false })
    expect(mapKey('Enter', 0, 0, 10)).toBeNull()
  })

  it("names the cell to start from in the live region on a focus from the keyboard, and none on a pointer's", () => {
    expect([focusSpokenCell(false, null, 25), focusSpokenCell(false, 7, 25), focusSpokenCell(false, 24, 3)]).toEqual([0, 7, 2])
    expect([focusSpokenCell(true, null, 25), focusSpokenCell(true, 7, 25), focusSpokenCell(false, null, 0)]).toEqual([null, null, null])
  })

  it('reads the focus a Tab gives after a touch that turned into a scroll, and not the focus of a click or tap', () => {
    // the canvas's events in order, then what its next focus is read as
    const nextFocusByPointer = (events: MapPointerEvent[]) => events.reduce((_, e) => pointerFocusAfter(e), false)
    expect(focusSpokenCell(nextFocusByPointer(['pointerdown']), null, 25)).toBeNull()
    expect(focusSpokenCell(nextFocusByPointer(['pointerdown', 'pointercancel']), null, 25)).toBe(0)
    expect(focusSpokenCell(nextFocusByPointer(['pointerdown', 'focus', 'blur']), 3, 25)).toBe(3)
    expect(focusSpokenCell(nextFocusByPointer(['focus', 'pointerdown', 'blur']), null, 25)).toBe(0)
  })
})

describe('what the node map says', () => {
  const trOf = (lng: 'en' | 'ko') => {
    const t = i18n.getFixedT(lng)
    return (key: string, fallback: string, options?: Record<string, any>) => t(key, { defaultValue: fallback, ...options })
  }
  const en = mapSpeech(trOf('en'))
  const ko = mapSpeech(trOf('ko'))
  const cell = (node: string, total: number, error: number, warn: number, status?: string): NodeEntry =>
    ({ node, label: node || 'Unscheduled', counts: { node, total, ok: total - error - warn, warn, error }, status })

  it('says that an arrow could go no further, at either end and on a map of one cell', () => {
    // 25 cells in rows of 10: the first and the last are the ends, an arrow up from the first row still moves to the first
    expect([mapKey('ArrowLeft', 0, 25, 10), mapKey('ArrowUp', 0, 25, 10), mapKey('ArrowRight', 24, 25, 10), mapKey('ArrowDown', 24, 25, 10)])
      .toEqual([{ hover: 0, end: true }, { hover: 0, end: true }, { hover: 24, end: true }, { hover: 24, end: true }])
    expect([mapKey('ArrowUp', 3, 25, 10), mapKey('ArrowDown', 23, 25, 10), mapKey('ArrowRight', 23, 25, 10)])
      .toEqual([{ hover: 0, end: false }, { hover: 24, end: false }, { hover: 24, end: false }])
    expect(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].map((k) => mapKey(k, 0, 1, 10))).toEqual(Array(4).fill({ hover: 0, end: true }))
    expect(en.end(cell('n0', 3, 0, 0))).toBe('n0 · 3 pods · 0 errors · 0 warnings (end)')
    expect(ko.end(cell('n0', 3, 0, 0))).toBe('n0 · Pod 3개 · 오류 0 · 주의 0 (끝)')
  })

  it('gives each line said again a new place in the live region, so it is read out again, and clears it', () => {
    const first = spokenAfter({ text: '', said: 0 }, 'n0 · 3 pods · 0 errors · 0 warnings (end)')
    const again = spokenAfter(first, first.text)
    expect([first.text === again.text, first.said === again.said]).toEqual([true, false])
    expect(spokenAfter(again, '')).toEqual({ text: '', said: 3 })
  })

  it('says one pod, one error and one warning in English, the cell and the line under the legend alike', () => {
    expect(en.cell(cell('n1', 1, 1, 0))).toBe('n1 · 1 pod · 1 error · 0 warnings')
    expect(en.cell(cell('n2', 2, 0, 1))).toBe('n2 · 2 pods · 0 errors · 1 warning')
    expect(en.cell(cell('n3', 3, 1, 1, 'NotReady'))).toBe('n3 · NotReady · 3 pods · 1 error · 1 warning')
    expect(en.cell(cell('', 1, 0, 1))).toBe('Unscheduled · 1 pod · 0 errors · 1 warning')
    expect(en.cell(cell('n4', 0, 0, 0))).toBe('n4 · 0 pods · 0 errors · 0 warnings')
    expect(ko.cell(cell('n1', 1, 1, 0))).toBe('n1 · Pod 1개 · 오류 1 · 주의 0')
    expect(ko.cell(cell('n3', 3, 1, 1, 'NotReady'))).toBe('n3 · NotReady · Pod 3개 · 오류 1 · 주의 1')
  })

  it('says which node Enter opened and how many pods its cell holds', () => {
    expect(en.opened(cell('e2e-a11y-b', 3, 1, 0, 'NotReady'))).toBe('e2e-a11y-b opened · 3 pods')
    expect(en.opened(cell('', 1, 0, 1))).toBe('Unscheduled opened · 1 pod')
    expect(ko.opened(cell('e2e-a11y-b', 3, 1, 0, 'NotReady'))).toBe('e2e-a11y-b 열림 · Pod 3개')
  })

  it('names the map with its counts, a full stop before the marks', () => {
    const counts = { nodes: 6, pods: 19, error: 2, warn: 3, notReady: 2, cordoned: 2 }
    expect(en.name(counts)).toBe('Node map: 6 nodes, 19 pods (2 errors, 3 warnings). 2 nodes not Ready, 2 SchedulingDisabled.')
    expect(ko.name(counts)).toBe('Node 지도: Node 6개, Pod 19개(오류 2, 주의 3). Ready가 아닌 Node 2개, SchedulingDisabled 2개입니다.')
    const one = { nodes: 1, pods: 1, error: 1, warn: 1, notReady: 1, cordoned: 0 }
    expect(en.name(one)).toBe('Node map: 1 node, 1 pod (1 error, 1 warning). 1 node not Ready, 0 SchedulingDisabled.')
    expect(en.name({ ...one, notReady: 0 })).toBe('Node map: 1 node, 1 pod (1 error, 1 warning).')
    expect(ko.name({ ...one, notReady: 0 })).toBe('Node 지도: Node 1개, Pod 1개(오류 1, 주의 1).')
  })

  it('counts the nodes as kubectl get nodes lists them: the node list once read, else the cells that are a node', () => {
    // dev's one node with an unscheduled pod: two cells, one node
    const cells = [cell('kubeast-control-plane', 31, 1, 0), cell('', 1, 0, 1)]
    expect(mapNodeCount(cells)).toBe(1)
    expect(mapNodeCount(cells, [{ name: 'kubeast-control-plane', roles: ['control-plane'], status: 'Ready' }])).toBe(1)
    // a node with no pod has no cell but is listed; a faded cell of a search is a node
    const list = ['cp-0', 'w-1', 'w-2'].map((name) => ({ name, roles: [], status: 'Ready' }))
    expect(mapNodeCount([cell('cp-0', 3, 0, 0), cell('', 2, 0, 0)], list)).toBe(3)
    expect(mapNodeCount([cell('cp-0', 3, 0, 0), { ...cell('w-1', 0, 0, 0), dim: true }, cell('', 2, 0, 0)])).toBe(2)
    expect(mapNodeCount([], [])).toBe(0)
  })
})

describe('node map dot shapes', () => {
  // the path a dot adds, as [command, x, y]
  const traced = (shape: 'triangle' | 'cross', x: number, y: number, size: number) => {
    const steps: (string | number)[][] = []
    traceDot({ moveTo: (a, b) => steps.push(['M', a, b]), lineTo: (a, b) => steps.push(['L', a, b]), closePath: () => steps.push(['Z']) }, shape, x, y, size)
    return steps
  }

  it('a healthy pod is a square, a warning a triangle, an error a cross', () => {
    expect(dotShape('ok', 6)).toBe('square')
    expect(dotShape('warn', 6)).toBe('triangle')
    expect(dotShape('error', 6)).toBe('cross')
  })

  it('a dot under the shape size stays a square whatever its kind', () => {
    for (const kind of ['ok', 'warn', 'error'] as const) {
      for (let size = 1; size < DOT_SHAPE_MIN; size++) expect(dotShape(kind, size), `${kind} ${size}px`).toBe('square')
    }
    expect(dotShape('warn', DOT_SHAPE_MIN)).toBe('triangle')
  })

  it('the triangle points up and stays inside the dot', () => {
    expect(traced('triangle', 10, 20, 6)).toEqual([['M', 13, 20], ['L', 16, 26], ['L', 10, 26], ['Z']])
  })

  it('the cross is two lines whose stroke stays inside the dot', () => {
    for (const size of [4, 6, 7, 11, 44]) {
      const w = crossWidth(size)
      const steps = traced('cross', 0, 0, size)
      expect(steps.map((s) => s[0])).toEqual(['M', 'L', 'M', 'L'])
      for (const [, x, y] of steps) {
        expect(Number(x) - w / 2, `${size}px`).toBeGreaterThanOrEqual(0)
        expect(Number(x) + w / 2, `${size}px`).toBeLessThanOrEqual(size)
        expect(Number(y) - w / 2, `${size}px`).toBeGreaterThanOrEqual(0)
        expect(Number(y) + w / 2, `${size}px`).toBeLessThanOrEqual(size)
      }
    }
  })
})
