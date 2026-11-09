import { describe, expect, it } from 'vitest'
import { pageOfItems } from './usePagedItems'

// A list held whole in the page is cut into pages of a given size: every item is on exactly one page, in order, and a
// page past the end (the list got shorter) shows the last page instead of an empty one.

const items = Array.from({ length: 523 }, (_, i) => i)

describe('pageOfItems', () => {
  it('puts every item on exactly one page, in order', () => {
    const seen: number[] = []
    const { totalPages } = pageOfItems(items, 1, 12)
    for (let p = 1; p <= totalPages; p++) seen.push(...pageOfItems(items, p, 12).items)
    expect({ totalPages, seen }).toEqual({ totalPages: 44, seen: items })
  })

  it('gives a page the size asked, the last page what is left', () => {
    expect(pageOfItems(items, 2, 25)).toEqual({ items: items.slice(25, 50), page: 2, totalPages: 21, total: 523 })
    expect(pageOfItems(items, 21, 25).items).toEqual(items.slice(500))
  })

  it('shows the last page when the page asked is past the end', () => {
    expect(pageOfItems(items.slice(0, 30), 9, 10)).toEqual({ items: items.slice(20, 30), page: 3, totalPages: 3, total: 30 })
  })

  it('has one empty page for an empty list, and reads a page below one as the first', () => {
    expect(pageOfItems([], 4, 10)).toEqual({ items: [], page: 1, totalPages: 1, total: 0 })
    expect(pageOfItems(items, 0, 10).page).toBe(1)
    expect(pageOfItems(items, -3, 10).items).toEqual(items.slice(0, 10))
  })

  it('takes at least one item per page whatever size it is given', () => {
    expect(pageOfItems(items.slice(0, 3), 2, 0)).toEqual({ items: [1], page: 2, totalPages: 3, total: 3 })
  })
})
