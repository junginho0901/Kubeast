import type { Member } from '@/services/api'

// auth-service resets only the password of an account made with one (400 for any other): an account single sign-on
// made signs in at the provider. A list that does not say how an account signs in keeps the button, and the server decides.
export function passwordResetOffered(u: Pick<Member, 'auth_source'>): boolean {
  return !u.auth_source || u.auth_source === 'password'
}
