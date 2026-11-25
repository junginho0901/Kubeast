import type { Member } from '@/services/api'

// auth-service resets the password of a password account and refuses any other (400): an account the provider made, or
// took over from a self sign-up, signs in there. It also resets the chart's admin account whatever made it, which this
// list cannot tell (reset-admin recovers that one). A list that does not say how an account signs in keeps the button,
// and the server decides.
export function passwordResetOffered(u: Pick<Member, 'auth_source'>): boolean {
  return !u.auth_source || u.auth_source === 'password'
}
