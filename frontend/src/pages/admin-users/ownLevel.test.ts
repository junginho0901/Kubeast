import { describe, expect, it } from 'vitest'
import { ownLevelChangeAsksSignIn } from './ownLevel'

describe('a change of one’s own account level', () => {
  it('asks to sign in again for any level but the built-in Admin', () => {
    expect(ownLevelChangeAsksSignIn('me', 'me', 'Member')).toBe(true)
    expect(ownLevelChangeAsksSignIn('me', 'me', 'Pending')).toBe(true)
    expect(ownLevelChangeAsksSignIn('me', 'me', undefined)).toBe(true)
  })

  it('keeps the session on the built-in Admin, known by its exact name', () => {
    expect(ownLevelChangeAsksSignIn('me', 'me', 'Admin')).toBe(false)
    expect(ownLevelChangeAsksSignIn('me', 'me', 'admin')).toBe(true)
    expect(ownLevelChangeAsksSignIn('me', 'me', 'ADMIN-renamed-8')).toBe(true)
  })

  it('asks nothing for another account’s level', () => {
    expect(ownLevelChangeAsksSignIn('me', 'other', 'Member')).toBe(false)
    expect(ownLevelChangeAsksSignIn(undefined, 'other', 'Member')).toBe(false)
  })
})
