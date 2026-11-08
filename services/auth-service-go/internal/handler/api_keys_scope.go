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

// roleRank orders the built-in cluster roles for the ceiling. A custom role has
// no rank: it keeps its name, since the cluster decides what its group may do
// and a built-in name would be another identity there.
var roleRank = map[string]int{"read": 1, "write": 2, "admin": 3}

// roleAtMost lowers a built-in role that ranks above ceiling to ceiling. Any
// other role comes back as it is.
func roleAtMost(role, ceiling string) string {
	r, builtin := roleRank[strings.ToLower(strings.TrimSpace(role))]
	if builtin && r > roleRank[strings.ToLower(ceiling)] {
		return ceiling
	}
	return role
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

// keyPermissions is everything a key's matrix holds, on any cluster.
func keyPermissions(matrix auth.PermissionMatrix) []string {
	var out []string
	for _, perms := range matrix {
		out = append(out, perms...)
	}
	return out
}

// narrowForAPIKey builds the matrix and cluster roles an exchanged token
// carries: one entry per cluster in clusterIDs, holding what the user has
// there cut down to ceilingPerms, and the role name of their grant there capped
// at ceiling. A global admin ("*") holds every cluster whatever their grant
// there, so the ceiling alone names their key's role; global admin.* keys are
// no ground for a cluster. No "*" entry survives, so a global admin's key
// reaches only the listed clusters. A cluster the user has nothing on is left
// out.
func narrowForAPIKey(matrix auth.PermissionMatrix, roles map[string]string, clusterIDs []string, ceiling string, ceilingPerms []string) (auth.PermissionMatrix, map[string]string) {
	out := auth.PermissionMatrix{}
	outRoles := map[string]string{}
	globalAdmin := auth.MatchAny(matrix["*"], "*")
	for _, c := range clusterIDs {
		c = strings.TrimSpace(c)
		if c == "" || c == "*" {
			continue
		}
		held := matrix[c]
		if globalAdmin {
			held = append([]string{"*"}, held...)
		}
		perms := intersectPerms(held, ceilingPerms)
		if len(perms) == 0 {
			continue
		}
		out[c] = perms
		if globalAdmin {
			outRoles[c] = ceiling
		} else if role := strings.TrimSpace(roles[c]); role != "" {
			outRoles[c] = roleAtMost(role, ceiling)
		}
	}
	return out, outRoles
}
