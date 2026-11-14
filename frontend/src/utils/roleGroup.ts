// The Kubernetes group a Kubeast role acts as on a cluster, as
// services/pkg/auth/impersonation.go builds it: Read, Write and Admin map to
// fixed groups the chart binds; any other (custom) role becomes
// kubeast:role:<slug>, which a cluster refuses until it allows and binds that
// group (chart auth.impersonation.customRoles). A built-in is known by its exact
// name; a custom role named as a built-in in other capitals ("ADMIN") acts as no
// role group (auth.TakesBuiltinSlug).
import { matchAny } from './permissions'

// The built-in roles' names as auth-service seeds them, and their slugs (auth.builtinRoleSlugs).
const BUILT_IN_SLUGS: Record<string, string> = { Pending: 'pending', Member: 'member', Read: 'read', Write: 'write', Admin: 'admin' }
const FIXED_GROUP = new Set(['Read', 'Write', 'Admin'])

export function isBuiltinRole(name: string | null | undefined): boolean {
  return !!name && Object.prototype.hasOwnProperty.call(BUILT_IN_SLUGS, name)
}

// Not a built-in's name, but a built-in's slug ("ADMIN", " read "): such a role acts as no role group on a cluster.
export function takesBuiltinSlug(name: string | null | undefined): boolean {
  if (!name || !name.trim() || isBuiltinRole(name)) return false
  return Object.values(BUILT_IN_SLUGS).includes(roleGroupSlug(name))
}

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

// kubeast:role:<slug> for a custom role, null for Read, Write or Admin (fixed groups), for a name of a built-in in other
// capitals (no role group) or none.
export function customRoleGroup(role: string | null | undefined): string | null {
  const name = role ?? ''
  if (!name.trim() || FIXED_GROUP.has(name) || takesBuiltinSlug(name)) return null
  return `kubeast:role:${roleGroupSlug(name)}`
}

// auth-service's refusal of a grant or an approval of a role whose name differs from another role's only in letter
// case, spaces or punctuation (code role_same_group), or null for any other answer.
export function sameGroupRefusal(err: unknown): { role: string; other: string } | null {
  const data = (err as { response?: { data?: { code?: string; role?: string; same_group_as?: string } } } | null)?.response?.data
  return data?.code === 'role_same_group' ? { role: data.role ?? '', other: data.same_group_as ?? '' } : null
}
