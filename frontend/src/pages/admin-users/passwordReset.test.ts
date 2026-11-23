import { describe, expect, it } from 'vitest'
import { passwordResetOffered } from './passwordReset'

describe('the Reset password button on User Management', () => {
  it('is offered for an account made with a password', () => {
    expect(passwordResetOffered({ auth_source: 'password' })).toBe(true)
  })

  it('is not offered for an account single sign-on made, which auth-service refuses', () => {
    expect(passwordResetOffered({ auth_source: 'oidc' })).toBe(false)
  })

  it('stays when the list does not say how the account signs in', () => {
    expect(passwordResetOffered({})).toBe(true)
  })
})
