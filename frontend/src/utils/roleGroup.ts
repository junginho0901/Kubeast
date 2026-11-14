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

// The role holding a name, as auth-service's roleNameConflict reads it: the first other role (in the list's id order)
// whose name makes the same group, so a name differing from it only in letter case, spaces or punctuation is taken.
// editing is the role being renamed: its own name is never taken, and its stored name sent back as the form sends it
// (trimmed) is not checked again, so a name stored before the rule stays usable.
export type TakenRoleName = { role: string; builtin: boolean; sameName: boolean }

export function takenRoleName(
  name: string,
  roles: ReadonlyArray<{ id: number; name: string; is_system: boolean }>,
  editing?: { id: number; name: string } | null,
): TakenRoleName | null {
  const trimmed = name.trim()
  if (!trimmed || (editing && trimmed === editing.name.trim())) return null
  const slug = roleGroupSlug(trimmed)
  const other = roles.find((r) => r.id !== editing?.id && roleGroupSlug(r.name) === slug)
  return other ? { role: other.name, builtin: other.is_system, sameName: other.name === trimmed } : null
}

// kubeast:role:<slug> for a custom role, null for a built-in role or none.
export function customRoleGroup(role: string | null | undefined): string | null {
  const name = (role ?? '').trim()
  if (!name || BUILT_IN.has(name.toLowerCase())) return null
  return `kubeast:role:${roleGroupSlug(name)}`
}
