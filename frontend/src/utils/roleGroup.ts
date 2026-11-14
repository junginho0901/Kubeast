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
  if (!name || !trimSpace(name) || isBuiltinRole(name)) return false
  return Object.values(BUILT_IN_SLUGS).includes(roleGroupSlug(name))
}

// Go's strings.TrimSpace: its whitespace, not String.trim's (which also takes U+FEFF and leaves U+0085).
const GO_SPACE = '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const GO_SPACE_ENDS = new RegExp(`^[${GO_SPACE}]+|[${GO_SPACE}]+$`, 'g')

function trimSpace(name: string): string {
  return name.replace(GO_SPACE_ENDS, '')
}

// Lowercase; anything other than a-z 0-9 . _ - becomes "-", one per character (groupSlug in Go, the database's
// role_group_slug; roleGroupSlug.cases.json holds the three equal). U+0130 lowers to "i" as in Go, not to two characters.
export function roleGroupSlug(name: string): string {
  return Array.from(trimSpace(name))
    .map((c) => (c === 'İ' ? 'i' : c.toLowerCase()))
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
// (trimmed) is not checked again, as auth-service does not check it.
export type TakenRoleName = { role: string; builtin: boolean; sameName: boolean }

export function takenRoleName(
  name: string,
  roles: ReadonlyArray<{ id: number; name: string; is_system: boolean }>,
  editing?: { id: number; name: string } | null,
): TakenRoleName | null {
  const trimmed = trimSpace(name)
  if (!trimmed || (editing && trimmed === trimSpace(editing.name))) return null
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
