// The Kubernetes group a Kubeast role acts as on a cluster, as
// services/pkg/auth/impersonation.go builds it: Read, Write and Admin map to
// fixed groups the chart binds; any other (custom) role becomes
// kubeast:role:<slug>, which a cluster refuses until it allows and binds that
// group (chart auth.impersonation.customRoles).
const BUILT_IN = new Set(['read', 'write', 'admin'])

// Lowercase; anything other than a-z 0-9 . _ - becomes "-" (groupSlug in Go).
export function roleGroupSlug(name: string): string {
  return Array.from(name.trim().toLowerCase())
    .map((c) => (/^[a-z0-9._-]$/.test(c) ? c : '-'))
    .join('')
}

// kubeast:role:<slug> for a custom role, null for a built-in role or none.
export function customRoleGroup(role: string | null | undefined): string | null {
  const name = (role ?? '').trim()
  if (!name || BUILT_IN.has(name.toLowerCase())) return null
  return `kubeast:role:${roleGroupSlug(name)}`
}
