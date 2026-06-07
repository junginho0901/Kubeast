package handler

import (
	"context"
	"strings"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// buildPermissionMatrix assembles the per-cluster permission matrix embedded in
// a user's JWT (00-COMMON §2-3, step 06):
//
//   - "*" entry — the user's GLOBAL permissions only: admin.* (and the "*"
//     superuser wildcard). Cluster-scoped perms (resource.*/menu.*/ai.tool.*)
//     from the global role are deliberately NOT placed here; on their own they
//     grant nothing.
//   - one entry per user_cluster_roles row, holding that role's full perms.
//
// deny-by-default: a cluster with no grant has no key, so HasForCluster denies
// it — there is no cluster fallback. A global admin ("*") reaches every cluster
// automatically, including ones registered later.
func (h *AuthHandler) buildPermissionMatrix(ctx context.Context, userID string, globalRolePerms []string) (auth.PermissionMatrix, error) {
	matrix := auth.PermissionMatrix{}

	var global []string
	for _, p := range globalRolePerms {
		if p == "*" || strings.HasPrefix(p, "admin.") {
			global = append(global, p)
		}
	}
	if len(global) > 0 {
		matrix["*"] = global
	}

	grants, err := h.repo.ListUserClusterRoles(ctx, userID)
	if err != nil {
		return nil, err
	}
	for _, g := range grants {
		perms, err := h.repo.GetPermissionsByRoleID(ctx, g.RoleID)
		if err != nil {
			return nil, err
		}
		matrix[g.ClusterID] = perms
	}
	return matrix, nil
}
