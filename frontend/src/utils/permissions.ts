// Per-cluster permission matrix on the frontend (step 06/09).
//
// The authoritative source is the JWT's `permissions` claim — the same matrix
// the backend enforces (services/pkg/auth). UI gating must use this rather than
// the global role's flat permission list, otherwise we'd show buttons the
// backend then 403s (a user's global role may include resource.* perms while
// their effective per-cluster access is deny-by-default until granted).

import { getAccessToken } from '@/services/auth'

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

// parsePermissions accepts only the per-cluster map form. A legacy flat array
// (pre-step-06) or a missing/!object claim yields an empty matrix (deny-all),
// matching the backend's reject-and-relogin behavior on the UI side.
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

function base64UrlDecode(seg: string): string {
  const b64 = seg.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  return atob(padded)
}

// decodeTokenMatrix extracts the permission matrix from a JWT (no signature
// verification — this is presentation-only; the backend enforces). Malformed
// tokens → empty matrix.
export function decodeTokenMatrix(token: string | null): PermissionMatrix {
  if (!token) return {}
  try {
    const seg = token.split('.')[1]
    if (!seg) return {}
    const claims = JSON.parse(base64UrlDecode(seg))
    return parsePermissions(claims.permissions)
  } catch {
    return {}
  }
}

// getTokenMatrix reads the matrix from the stored access token.
export function getTokenMatrix(): PermissionMatrix {
  return decodeTokenMatrix(getAccessToken())
}
