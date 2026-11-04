import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EventsTable } from './DetailCommon'

// the drawer's Events table as first drawn (page 1)
const html = (n: number) => renderToStaticMarkup(createElement(EventsTable, {
  events: Array.from({ length: n }, (_, i) => ({ type: 'Normal', reason: `Seen${String(i).padStart(2, '0')}`, message: `event ${i}`, count: 1 })),
}))
const rows = (out: string) => (out.split('<tbody')[1] ?? '').match(/<tr\b/g)?.length ?? 0

describe('EventsTable', () => {
  it('shows every event, ten to a page with the range of all of them', () => {
    const out = html(55)
    expect(rows(out)).toBe(10)
    expect(out).toContain('<span>1-10 / 55</span>')
    expect(out).toContain('Seen09')
    expect(out).not.toContain('Seen10')
  })

  it('draws a page that fits without a pager, and "None" without events', () => {
    const out = html(7)
    expect(rows(out)).toBe(7)
    expect(out).not.toContain(' / 7<')
    expect(html(0)).toContain('None')
  })
})
