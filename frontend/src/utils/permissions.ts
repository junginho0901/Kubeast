// Per-cluster permission matrix on the frontend (step 06/09).
//
// The authoritative source is the matrix GET /auth/me returns — the same one
// the backend puts in the JWT and enforces (services/pkg/auth). UI gating must
// use this rather than the global role's flat permission list, otherwise we'd
// show buttons the backend then 403s (a user's global role may include
// resource.* perms while their effective per-cluster access is deny-by-default
// until granted).

// clusterID → permission keys. The "*" entry holds GLOBAL (admin.*) perms and,
// for a superuser, the "*" wildcard.
export type PermissionMatrix = Record<string, string[]>

// permMatches mirrors pkg/auth permMatches (Go) and ai-service security.py:
// "*" grants everything; a "*" segment matches exactly one segment
// ("resource.*.read" → "resource.pod.read"); a trailing "*" matches the rest
// ("ai.tool.*" → "ai.tool.k8s_scale").
export function permMatches(pattern: string, perm: string): boolean {
  if (pattern === '*' || pattern === perm) return true
  const ps = pattern.split('.')
  const qs = perm.split('.')
  for (let i = 0; i < ps.length; i++) {
    if (ps[i] === '*' && i === ps.length - 1) return qs.length >= ps.length
    if (i >= qs.length || (ps[i] !== '*' && ps[i] !== qs[i])) return false
  }
  return ps.length === qs.length
}

export function matchAny(perms: string[] | undefined, perm: string): boolean {
  if (!perms) return false
  return perms.some((p) => permMatches(p, perm))
}

// hasPermission honors the all-cluster "*" entry always; the concrete cluster's
// entry is consulted when clusterID is a real id (deny-by-default — no fallback).
export function hasPermission(matrix: PermissionMatrix, perm: string, clusterID = ''): boolean {
  if (matchAny(matrix['*'], perm)) return true
  return clusterID ? matchAny(matrix[clusterID], perm) : false
}

// parsePermissions accepts only the per-cluster map form. A flat array or a
// missing/!object value yields an empty matrix (deny-all), matching the
// backend's reject-and-relogin behavior on the UI side.
export function parsePermissions(raw: unknown): PermissionMatrix {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: PermissionMatrix = {}
  for (const [cid, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(v)) {
      out[cid] = v.filter((p): p is string => typeof p === 'string')
    }
  }
  return out
}
