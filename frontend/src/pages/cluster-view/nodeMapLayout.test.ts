import { describe, it, expect } from 'vitest'
import { GAP, layoutMap, mapKey } from './nodeMapLayout'
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
    expect(mapKey('ArrowRight', null, 25, 10)).toEqual({ hover: 1 })
    expect(mapKey('ArrowDown', 3, 25, 10)).toEqual({ hover: 13 })
    expect(mapKey('ArrowDown', 18, 25, 10)).toEqual({ hover: 24 })
    expect(mapKey('ArrowUp', 4, 25, 10)).toEqual({ hover: 0 })
    expect(mapKey('ArrowLeft', 0, 25, 10)).toEqual({ hover: 0 })
    expect(mapKey('Enter', 13, 25, 10)).toEqual({ open: 13 })
    expect(mapKey(' ', null, 25, 10)).toEqual({ open: 0 })
    expect([mapKey('Tab', 3, 25, 10), mapKey('a', 3, 25, 10), mapKey('constructor', 3, 25, 10)]).toEqual([null, null, null])
  })

  it('opens the last cell, never one past it, when the cells became fewer under the cell reached', () => {
    // the 25th cell reached, then the map down to 3 cells (its pods gone, a search narrowed)
    expect(mapKey('Enter', 24, 3, 10)).toEqual({ open: 2 })
    expect(mapKey('ArrowLeft', 24, 3, 10)).toEqual({ hover: 1 })
    expect(mapKey('Enter', 0, 0, 10)).toBeNull()
  })
})
