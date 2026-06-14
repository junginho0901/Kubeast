package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// Per-cluster role grants (step 08). These let an admin give a user a role on a
// specific cluster (deny-by-default: no grant = no access). Grants take effect
// on the user's NEXT token issuance (re-login) — buildPermissionMatrix reads
// user_cluster_roles at login. All three require admin.users.update.
//
// Mounted under the existing admin-users group:
//   GET    /auth/admin/users/{user_id}/cluster-roles
//   PUT    /auth/admin/users/{user_id}/cluster-roles/{cluster_id}   { "role": "Read" }
//   DELETE /auth/admin/users/{user_id}/cluster-roles/{cluster_id}

type setClusterRoleRequest struct {
	Role string `json:"role"` // role name, e.g. "Admin" / "Read"
}

// GetUserClusterRoles returns the user's grants as { clusterID: roleName }.
func (h *AuthHandler) GetUserClusterRoles(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireClusterRoleAdmin(w, r); !ok {
		return
	}
	userID := chi.URLParam(r, "user_id")

	target, err := h.repo.GetUserByID(r.Context(), userID)
	if err != nil || target == nil {
		response.Error(w, http.StatusNotFound, "User not found")
		return
	}
	roles, err := h.repo.ListUserClusterRoleNames(r.Context(), userID)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.JSON(w, http.StatusOK, roles)
}

// GetClusterUserRoles returns the per-cluster access list for one cluster: every
// user that has a grant on it and their role (the inverse of GetUserClusterRoles,
// for the cluster-management "who has access" modal).
func (h *AuthHandler) GetClusterUserRoles(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireClusterRoleAdmin(w, r); !ok {
		return
	}
	clusterID := chi.URLParam(r, "cluster_id")
	rows, err := h.repo.ListClusterUserRoles(r.Context(), clusterID)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.JSON(w, http.StatusOK, rows)
}

// SetUserClusterRole grants (or re-grants) a role to the user on a cluster.
func (h *AuthHandler) SetUserClusterRole(w http.ResponseWriter, r *http.Request) {
	payload, ok := h.requireClusterRoleAdmin(w, r)
	if !ok {
		return
	}
	userID := chi.URLParam(r, "user_id")
	clusterID := chi.URLParam(r, "cluster_id")

	var req setClusterRoleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Role == "" {
		response.Error(w, http.StatusBadRequest, "Invalid request body: role required")
		return
	}

	target, err := h.repo.GetUserByID(r.Context(), userID)
	if err != nil || target == nil {
		response.Error(w, http.StatusNotFound, "User not found")
		return
	}
	role, err := h.repo.GetRoleByName(r.Context(), req.Role)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	if role == nil {
		response.Error(w, http.StatusBadRequest, "Unknown role: "+req.Role)
		return
	}

	setErr := h.repo.SetUserClusterRole(r.Context(), userID, clusterID, role.ID)
	h.auditClusterRole(r, "user.cluster_role.set", payload, userID, target.Email, clusterID,
		map[string]any{"role": req.Role}, setErr)
	if setErr != nil {
		response.Error(w, http.StatusInternalServerError, setErr.Error())
		return
	}
	response.JSON(w, http.StatusOK, map[string]string{"cluster_id": clusterID, "role": req.Role})
}

// DeleteUserClusterRole revokes the user's access to a cluster.
func (h *AuthHandler) DeleteUserClusterRole(w http.ResponseWriter, r *http.Request) {
	payload, ok := h.requireClusterRoleAdmin(w, r)
	if !ok {
		return
	}
	userID := chi.URLParam(r, "user_id")
	clusterID := chi.URLParam(r, "cluster_id")

	target, err := h.repo.GetUserByID(r.Context(), userID)
	if err != nil || target == nil {
		response.Error(w, http.StatusNotFound, "User not found")
		return
	}

	existed, delErr := h.repo.DeleteUserClusterRole(r.Context(), userID, clusterID)
	h.auditClusterRole(r, "user.cluster_role.unset", payload, userID, target.Email, clusterID, nil, delErr)
	if delErr != nil {
		response.Error(w, http.StatusInternalServerError, delErr.Error())
		return
	}
	if !existed {
		response.Error(w, http.StatusNotFound, "No such grant")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// requireClusterRoleAdmin gates the cluster-role endpoints on admin.users.update.
func (h *AuthHandler) requireClusterRoleAdmin(w http.ResponseWriter, r *http.Request) (auth.TokenPayload, bool) {
	payload, ok := auth.FromContext(r.Context())
	if !ok || !payload.HasPermission("admin.users.update") {
		response.Error(w, http.StatusForbidden, "Permission denied")
		return auth.TokenPayload{}, false
	}
	return payload, true
}

// auditClusterRole records a user.cluster_role.set/.unset entry with the cluster
// scoped on the record. Best-effort: a failed write never blocks the response.
func (h *AuthHandler) auditClusterRole(r *http.Request, action string, actor auth.TokenPayload, userID, targetEmail, clusterID string, after map[string]any, opErr error) {
	rec := audit.FromHTTPRequest(r)
	rec.Service = audit.ServiceAuth
	rec.Action = action
	rec.TargetType = "user"
	rec.TargetID = userID
	rec.TargetEmail = targetEmail
	rec.Cluster = clusterID
	rec.ActorUserID = actor.UserID
	rec.ActorEmail = actor.Email
	if after != nil {
		rec.After = audit.MustJSON(after)
	}
	if opErr != nil {
		rec.Result = audit.ResultFailure
		rec.Error = opErr.Error()
	}
	if _, err := h.auditStore.Write(r.Context(), rec); err != nil {
		// Best-effort: log and move on (audit must not abort the operation).
		slog.Error("failed to create audit log", "error", err, "action", action)
	}
}
