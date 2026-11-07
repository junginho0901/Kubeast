// The Kubernetes group a Kubeast role acts as on a cluster, as
// services/pkg/auth/impersonation.go builds it: Read, Write and Admin map to
// fixed groups the chart binds; any other (custom) role becomes
// kubeast:role:<slug>, which a cluster refuses until it allows and binds that
// group (chart auth.impersonation.customRoles).
import { matchAny } from './permissions'

const BUILT_IN = new Set(['read', 'write', 'admin'])

// Lowercase; anything other than a-z 0-9 . _ - becomes "-" (groupSlug in Go).
export function roleGroupSlug(name: string): string {
  return Array.from(name.trim().toLowerCase())
    .map((c) => (/^[a-z0-9._-]$/.test(c) ? c : '-'))
    .join('')
}

// Whether saving this edit ends the sessions of those holding the role, as auth-service's tokensEndedBy decides: a
// permission no longer covered, or a name that makes another group. An added permission and the description do not.
export function roleEditEndsSessions(before: { name: string; permissions?: string[] }, name: string, permissions: Iterable<string>): boolean {
  if (roleGroupSlug(name) !== roleGroupSlug(before.name)) return true
  const now = Array.from(permissions)
  return (before.permissions ?? []).some((permission) => !matchAny(now, permission))
}

// kubeast:role:<slug> for a custom role, null for a built-in role or none.
export function customRoleGroup(role: string | null | undefined): string | null {
  const name = (role ?? '').trim()
  if (!name || BUILT_IN.has(name.toLowerCase())) return null
  return `kubeast:role:${roleGroupSlug(name)}`
}
