import { describe, expect, it } from 'vitest'
import { pageOf } from './listPages'

const accounts = (n: number) => Array.from({ length: n }, (_, i) => `user-${String(i).padStart(4, '0')}`)

describe('a list paged in the browser', () => {
  it('cuts a thousand rows into pages of the rows the table fits', () => {
    const all = accounts(1000)
    const first = pageOf(all, 1, 12)
    expect(first.rows).toEqual(all.slice(0, 12))
    expect(first.pages).toBe(84)
    const last = pageOf(all, 84, 12)
    expect(last.rows).toEqual(all.slice(996))
    expect(last.page).toBe(84)
  })

  it('reaches every row once over the pages', () => {
    const all = accounts(205)
    const { pages } = pageOf(all, 1, 25)
    const seen = Array.from({ length: pages }, (_, i) => pageOf(all, i + 1, 25).rows).flat()
    expect(seen).toEqual(all)
  })

  it('keeps the page within the pages there are when the list gets shorter', () => {
    const shown = pageOf(accounts(30), 9, 10)
    expect(shown.page).toBe(3)
    expect(shown.rows).toEqual(accounts(30).slice(20))
  })

  it('an empty list is one page with no rows', () => {
    expect(pageOf([], 1, 10)).toEqual({ rows: [], page: 1, pages: 1 })
    expect(pageOf([], 4, 10)).toEqual({ rows: [], page: 1, pages: 1 })
  })

  it('takes a page before the first as the first', () => {
    expect(pageOf(accounts(30), 0, 10).rows).toEqual(accounts(10))
  })
})
