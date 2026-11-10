import { describe, expect, it } from 'vitest'
import type { InvestigationSummary } from '@/services/api/investigations'
import { investigationsView } from './investigationsView'

const items = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ id: `inv-${from + i}` }) as InvestigationSummary)

describe('investigationsView', () => {
  it('draws the range, page and filter of the answer on screen while another loads', () => {
    // page 2 of the done reports asked; page 1 of every report still on screen
    const shown = { items: items(50), total: 408, filter: { status: '', cluster: '' }, page: 1, limit: 50 }
    const v = investigationsView(shown, 2, 50)
    expect([v.shownPage, v.first, v.last, v.total, v.hasNext]).toEqual([1, 1, 50, 408, true])
    expect(v.shownFilter).toEqual({ status: '', cluster: '' })
  })

  it('ends at the last page', () => {
    const v = investigationsView({ items: items(10, 50), total: 60, filter: { status: 'done', cluster: 'self' }, page: 2, limit: 50 }, 2, 50)
    expect([v.first, v.last, v.hasNext, v.shownFilter.status]).toEqual([51, 60, false, 'done'])
  })

  it('has nothing before the first answer', () => {
    const v = investigationsView(undefined, 3, 50)
    expect([v.rows.length, v.total, v.shownPage, v.hasNext]).toEqual([0, 0, 3, false])
  })

  it('counts the range and the pages with the rows per page of the answer on screen, while the screen asks another', () => {
    // page 3 of 12 rows on screen (rows 25-36 of 60); the screen grew and now asks 15 a page
    const v = investigationsView({ items: items(12, 24), total: 60, filter: { status: '', cluster: '' }, page: 3, limit: 12 }, 3, 15)
    expect([v.first, v.last, v.limit, v.pages, v.hasNext]).toEqual([25, 36, 12, 5, true])
    // before any answer: the rows per page asked
    const none = investigationsView(undefined, 1, 15)
    expect([none.limit, none.pages]).toEqual([15, 1])
  })
})
