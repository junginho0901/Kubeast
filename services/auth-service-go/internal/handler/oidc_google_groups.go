package handler

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/response"
)

// groupLookup is googlegroups.Client; a fake in tests.
type groupLookup interface {
	Groups(ctx context.Context, email string) ([]string, error)
}

const groupLookupTimeout = 5 * time.Second

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// SetGoogleGroups turns on the Google Workspace group lookup at OIDC sign-in.
func (h *AuthHandler) SetGoogleGroups(g groupLookup) { h.googleGroups = g }

// mappedGroup: a group the role mapping, the cluster group mapping or the
// cluster group prefix uses. Only these are taken from the lookup, so the
// audit rows that list a user's groups do not carry every company group.
func (h *AuthHandler) mappedGroup(g string) bool {
	o := h.cfg.OIDC
	if _, ok := o.RoleMapping[g]; ok {
		return true
	}
	if _, ok := o.ClusterGroupMapping[g]; ok {
		return true
	}
	return o.ClusterGroupPrefix != "" && strings.HasPrefix(g, o.ClusterGroupPrefix)
}

// addGoogleGroups adds the user's mapped Google groups to the claims. A failed
// lookup leaves the claims as they were, so the current role stays (the role
// sync only runs when groups are known). The answer goes into the login audit row.
func (h *AuthHandler) addGoogleGroups(ctx context.Context, claims *oidcClaims) string {
	if h.googleGroups == nil {
		return ""
	}
	ctx, cancel := context.WithTimeout(ctx, groupLookupTimeout)
	defer cancel()
	groups, err := h.googleGroups.Groups(ctx, claims.Email)
	if err != nil {
		slog.Warn("google group lookup failed; keeping the current role", "email", claims.Email, "error", err)
		return "failed: " + truncate(err.Error(), 200)
	}
	for _, g := range groups {
		if h.mappedGroup(g) {
			claims.Groups = append(claims.Groups, g)
		}
	}
	claims.HasGroups = true
	return "ok"
}

// clusterGrantsOf: the per-cluster roles from the prefix groups and the
// cluster group mapping; the higher role wins for one cluster.
func (h *AuthHandler) clusterGrantsOf(groups []string) map[string]string {
	out := clusterGrants(groups, h.cfg.OIDC.ClusterGroupPrefix)
	for _, g := range groups {
		grant, ok := h.cfg.OIDC.ClusterGroupMapping[g]
		if !ok {
			continue
		}
		id, role, _ := strings.Cut(grant, ":")
		if cur, exists := out[id]; !exists || rolePrecedence(role) < rolePrecedence(cur) {
			out[id] = role
		}
	}
	return out
}

// AdminOIDCGroups handles GET /admin/oidc/groups?email= (admin.users.read): the
// groups a user would bring at sign-in and what they map to, without signing
// in. Only mapped groups are named; the rest are counted.
func (h *AuthHandler) AdminOIDCGroups(w http.ResponseWriter, r *http.Request) {
	actor, ok := requirePerm(h.auditStore, w, r, "admin.users.read")
	if !ok {
		return
	}
	if h.googleGroups == nil {
		response.Error(w, http.StatusNotFound, "Google group lookup is not enabled (auth.oidc.googleGroups)")
		return
	}
	email := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("email")))
	if !strings.Contains(email, "@") {
		response.Error(w, http.StatusBadRequest, "email is required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), groupLookupTimeout)
	defer cancel()
	groups, err := h.googleGroups.Groups(ctx, email)
	if err != nil {
		msg := truncate(err.Error(), 200)
		h.writeAuditFailure(r, "admin.oidc.groups.read", &actor.UserID, &actor.Email, nil, &email, msg, nil)
		response.Error(w, http.StatusBadGateway, "Google group lookup failed: "+msg)
		return
	}
	mapped := []string{}
	for _, g := range groups {
		if h.mappedGroup(g) {
			mapped = append(mapped, g)
		}
	}
	role, from := mapRole(mapped, h.cfg.OIDC.RoleMapping), "mapping"
	if role == "" {
		role, from = h.cfg.OIDC.DefaultRole, "default"
	}
	grants := h.clusterGrantsOf(mapped)
	h.writeAuditLog(r, "admin.oidc.groups.read", &actor.UserID, &actor.Email, nil, &email, nil,
		jsonRaw(map[string]any{"mapped_groups": len(mapped), "other_groups": len(groups) - len(mapped), "role": role, "cluster_grants": len(grants)}))
	response.JSON(w, http.StatusOK, map[string]any{
		"email":          email,
		"mapped_groups":  mapped,
		"other_groups":   len(groups) - len(mapped),
		"role":           role,
		"role_from":      from,
		"cluster_grants": grants,
	})
}
