// The session's token holds the account level it was issued with: after a change of one's own level to anything but
// the built-in Admin, known by its exact name as auth-service reads it (a custom role named "admin" is not it), the
// screen asks to sign in again.
export function ownLevelChangeAsksSignIn(meId: string | undefined, userId: string, roleName: string | undefined): boolean {
  return !!meId && userId === meId && roleName !== 'Admin'
}
