import { describe, expect, it } from 'vitest'
import source from './AlertInbox.tsx?raw'
import { inboxPage } from './inboxPage'

// The Alerts inbox reads a page at the Fit count. Opened, it asks at a count made from an estimated row height (46 px)
// before a row is drawn; its rows wrap to 85–101 px, so the measured count is smaller and the page is asked again.
// While that answer comes the first one stays on screen: cut at the rows that fit, not drawn whole below the box.

const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `a${from + i}`)

describe('the Alerts inbox page drawn from an answer', () => {
  it('cuts a first page asked at the estimate to the rows that fit now, its range counted with them', () => {
    expect(inboxPage({ items: ids(9), filter: { offset: 0, limit: 9 } }, 4)).toEqual({ rows: ids(4), limit: 4 })
  })

  it('draws the page asked at the count whole', () => {
    expect(inboxPage({ items: ids(4), filter: { offset: 0, limit: 4 } }, 4)).toEqual({ rows: ids(4), limit: 4 })
    expect(inboxPage({ items: ids(2), filter: { offset: 0, limit: 4 } }, 4)).toEqual({ rows: ids(2), limit: 4 })
  })

  it('keeps another page on screen at the size it was read with while the next one loads', () => {
    expect(inboxPage({ items: ids(4, 4), filter: { offset: 4, limit: 4 } }, 5)).toEqual({ rows: ids(4, 4), limit: 4 })
  })

  it('draws nothing before the first answer', () => {
    expect(inboxPage(undefined, 4)).toEqual({ rows: [], limit: 4 })
  })

  it('is what the page draws: its rows, the range and the pages', () => {
    expect(source).toContain('const { rows, limit: shownLimit } = inboxPage(data, rowsPerPage)')
    expect(source).toContain('const shown = data ? { ...data.filter, limit: shownLimit, page: data.page } : { ...filter, page }')
    expect(source).toContain('rowsPerPage={shown.limit}')
    expect(source).not.toContain('data?.items')
  })
})
