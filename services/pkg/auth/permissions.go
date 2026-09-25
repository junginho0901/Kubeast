package auth

import "strings"

// PermissionMatrix maps a cluster ID to the permission keys granted in that
// cluster. The special key "*" applies to every cluster — it carries the
// caller's global (admin.*) permissions and, for a full superuser, the "*"
// wildcard. Per-cluster resource/menu/ai.tool permissions live under the
// concrete cluster id and ONLY there (deny-by-default — no cluster fallback,
// 00-COMMON §2-3).
type PermissionMatrix map[string][]string

// ParsePermissions converts a raw JWT "permissions" claim into a matrix.
//
// Only the per-cluster map form is accepted. The legacy flat-array form (and a
// missing/!map claim) returns nil so the caller rejects the token with 401 and
// forces a one-time re-login after the format switch (00-COMMON §2-3). An empty
// map is a valid (deny-everything) matrix and is NOT rejected.
func ParsePermissions(raw any) PermissionMatrix {
	m, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	out := make(PermissionMatrix, len(m))
	for cid, v := range m {
		list, ok := v.([]any)
		if !ok {
			continue
		}
		perms := make([]string, 0, len(list))
		for _, p := range list {
			if s, ok := p.(string); ok {
				perms = append(perms, s)
			}
		}
		out[cid] = perms
	}
	return out
}

// HasForCluster reports whether perm is granted in clusterID. The all-cluster
// entry ("*") is always consulted; the concrete cluster's entry is consulted
// when clusterID is a real id. Matching reuses the wildcard rules: exact, full
// "*", and prefix globs like "resource.*".
func (m PermissionMatrix) HasForCluster(perm, clusterID string) bool {
	if matchAny(m["*"], perm) {
		return true
	}
	if clusterID != "" && clusterID != "*" {
		return matchAny(m[clusterID], perm)
	}
	return false
}

func matchAny(perms []string, perm string) bool {
	for _, pp := range perms {
		if permMatches(pp, perm) {
			return true
		}
	}
	return false
}

// permMatches compares a granted pattern with a required permission key by
// dot-separated segment: "*" alone grants everything; a "*" segment matches
// exactly one segment ("resource.*.read" → "resource.pod.read"); a trailing
// "*" matches the rest ("ai.tool.*" → "ai.tool.k8s_scale"). The seeded system
// roles rely on the middle form, so it must be honoured by every validator
// (Go here, ai-service security.py, frontend utils/permissions.ts).
func permMatches(pattern, perm string) bool {
	if pattern == "*" || pattern == perm {
		return true
	}
	ps := strings.Split(pattern, ".")
	qs := strings.Split(perm, ".")
	for i, seg := range ps {
		if seg == "*" && i == len(ps)-1 {
			return len(qs) >= len(ps)
		}
		if i >= len(qs) || (seg != "*" && seg != qs[i]) {
			return false
		}
	}
	return len(ps) == len(qs)
}
