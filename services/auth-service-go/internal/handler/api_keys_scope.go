package handler

import (
	"sort"
	"strings"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// The scope of an API key, applied when it is exchanged for a token: the
// user's permissions at that moment are the upper bound, the key only cuts
// them down (the same rule as the permission ceiling for grants — nobody
// hands out more than they hold).

// roleRank orders the built-in cluster roles for the ceiling. A custom role
// has no rank, so under a ceiling it is replaced by the ceiling role.
var roleRank = map[string]int{"read": 1, "write": 2, "admin": 3}

// roleAtMost returns role when it ranks at or below ceiling, else ceiling.
func roleAtMost(role, ceiling string) string {
	r, ok := roleRank[strings.ToLower(strings.TrimSpace(role))]
	if ok && r <= roleRank[strings.ToLower(ceiling)] {
		return role
	}
	return ceiling
}

// intersectPerms keeps what both sets grant, wildcards on either side
// honoured: a "*" or "k8s.pods.*" entry on one side keeps the other side's
// matching entries; the wildcard itself survives only when the other side
// holds it too.
func intersectPerms(a, b []string) []string {
	seen := map[string]struct{}{}
	var out []string
	add := func(p string) {
		if _, dup := seen[p]; !dup {
			seen[p] = struct{}{}
			out = append(out, p)
		}
	}
	for _, p := range a {
		if auth.MatchAny(b, p) {
			add(p)
		}
	}
	for _, p := range b {
		if auth.MatchAny(a, p) {
			add(p)
		}
	}
	sort.Strings(out)
	return out
}

// narrowForAPIKey builds the matrix and cluster roles an exchanged token
// carries: one entry per cluster in clusterIDs, holding what the user has
// there (the global "*" entry counts everywhere) cut down to ceilingPerms,
// and the role name capped at ceiling. No "*" entry survives, so a global
// admin's key reaches only the listed clusters. A cluster the user has
// nothing on is left out.
func narrowForAPIKey(matrix auth.PermissionMatrix, roles map[string]string, clusterIDs []string, ceiling string, ceilingPerms []string) (auth.PermissionMatrix, map[string]string) {
	out := auth.PermissionMatrix{}
	outRoles := map[string]string{}
	global := matrix["*"]
	for _, c := range clusterIDs {
		c = strings.TrimSpace(c)
		if c == "" || c == "*" {
			continue
		}
		effective := append(append([]string{}, global...), matrix[c]...)
		perms := intersectPerms(effective, ceilingPerms)
		if len(perms) == 0 {
			continue
		}
		out[c] = perms
		if role, ok := roles[c]; ok && strings.TrimSpace(role) != "" {
			outRoles[c] = roleAtMost(role, ceiling)
		} else {
			outRoles[c] = ceiling
		}
	}
	return out, outRoles
}
