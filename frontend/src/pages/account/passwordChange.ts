// Change password (auth-service ChangePassword): a wrong current password is a 403 with the reason `password_mismatch`,
// which the window says under that field. A refusal of the field is never a 401: the console reads a 401 as the sign-in
// being over.

/** Whether the server refused the change because the current password is wrong; any other failure is shown with its
 * reason above the form. */
export function wrongCurrentPassword(error: unknown): boolean {
  const res = (error as { response?: { status?: unknown; data?: { reason?: unknown } } } | null | undefined)?.response
  return res?.status === 403 && res.data?.reason === 'password_mismatch'
}
