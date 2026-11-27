import i18next from 'i18next'
import { describe, expect, it } from 'vitest'
import en from '../../i18n/locales/en.json'
import ko from '../../i18n/locales/ko.json'
import adminUsersSrc from '../AdminUsers.tsx?raw'
import { allPendingSelected, pendingAccountName, toggleAllFound, toggleAllPending, toggleOnePending } from './pendingSelection'

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

// A row's box had no name (WCAG 4.1.2): a screen reader read "checkbox, not checked" on every row of the window.
describe('a pending account\'s box', () => {
  it('is named for the account its row shows, by name and email, in English and Korean', async () => {
    expect(pendingAccountName({ name: 'Kim', email: 'kim@example.com' })).toBe('Kim (kim@example.com)')
    expect(pendingAccountName({ name: 'Kim' })).toBe('Kim')
    expect(pendingAccountName({ name: 'Kim', email: null })).toBe('Kim')

    const i18n = i18next.createInstance()
    await i18n.init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false } })
    const account = pendingAccountName({ name: 'Kim', email: 'kim@example.com' })
    expect(i18n.t('adminUsers.bulk.selectAccount', { account })).toBe('Select Kim (kim@example.com)')
    expect(i18n.getFixedT('ko')('adminUsers.bulk.selectAccount', { account })).toBe('Kim (kim@example.com) 선택')

    // the window opens on a click, which a static render does not make: the row's box is read from the source
    expect(adminUsersSrc).toMatch(/checked=\{isChecked\}[\s\S]{0,200}?aria-label=\{tr\('adminUsers\.bulk\.selectAccount', 'Select \{\{account\}\}', \{ account: pendingAccountName\(u\) \}\)\}/)
  })
})
