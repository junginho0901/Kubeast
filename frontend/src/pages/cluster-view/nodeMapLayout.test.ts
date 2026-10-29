import { describe, it, expect } from 'vitest'
import { GAP, layoutMap } from './nodeMapLayout'
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
