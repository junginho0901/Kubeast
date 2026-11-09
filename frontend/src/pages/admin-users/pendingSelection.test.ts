import { describe, expect, it } from 'vitest'
import { allPendingSelected, toggleAllPending, toggleOnePending } from './pendingSelection'

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
})
