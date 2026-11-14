import { describe, expect, it } from 'vitest'
import { allPendingSelected, toggleAllFound, toggleAllPending, toggleOnePending } from './pendingSelection'

// The Pending window pages its accounts ten at a time; what is chosen is kept by account id across the pages, and
// the box in the header row chooses every pending account, on every page.
const pending = Array.from({ length: 35 }, (_, i) => `p${i}`)

describe('choosing pending accounts', () => {
  it('the header box chooses every pending account, also those on other pages', () => {
    const all = toggleAllPending(new Set(), pending)
    expect([...all].sort()).toEqual([...pending].sort())
    expect(allPendingSelected(all, pending)).toBe(true)
    // pressed again: none
    expect(toggleAllPending(all, pending).size).toBe(0)
  })

  it('a choice made on one page stays when another page is shown', () => {
    let chosen = toggleOnePending(new Set(), 'p3')
    chosen = toggleOnePending(chosen, 'p27')
    expect([...chosen]).toEqual(['p3', 'p27'])
    expect(allPendingSelected(chosen, pending)).toBe(false)
    expect([...toggleOnePending(chosen, 'p3')]).toEqual(['p27'])
  })

  it('reads every account as chosen only when each pending one is, not when the count matches', () => {
    // one account approved elsewhere meanwhile: still in the choice, no longer pending
    const chosen = new Set(['p0', 'gone'])
    expect(allPendingSelected(chosen, ['p0', 'p1'])).toBe(false)
    // the header box then chooses every pending account instead of clearing
    expect([...toggleAllPending(chosen, ['p0', 'p1'])].sort()).toEqual(['p0', 'p1'])
  })

  it('no pending account: the header box is not checked', () => {
    expect(allPendingSelected(new Set(), [])).toBe(false)
  })

  it('with text in the search the header box chooses the accounts it finds, on every page, and keeps the others chosen', () => {
    const found = ['p3', 'p13', 'p23', 'p33']
    const chosen = toggleAllFound(new Set(['p0']), found)
    expect([...chosen].sort()).toEqual(['p0', 'p13', 'p23', 'p3', 'p33'])
    expect(allPendingSelected(chosen, found)).toBe(true)
    expect(allPendingSelected(chosen, pending)).toBe(false)
    // pressed again: the found ones go, the one chosen before the search stays
    expect([...toggleAllFound(chosen, found)]).toEqual(['p0'])
  })

  it('with some of the found accounts chosen the header box chooses the rest of them', () => {
    expect([...toggleAllFound(new Set(['p13']), ['p3', 'p13'])].sort()).toEqual(['p13', 'p3'])
  })

  it('a search that finds none leaves the choice as it is', () => {
    const chosen = new Set(['p1', 'p2'])
    expect(allPendingSelected(chosen, [])).toBe(false)
    expect([...toggleAllFound(chosen, [])]).toEqual(['p1', 'p2'])
  })
})
