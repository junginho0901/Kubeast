package handler

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// Access requests: temporary per-cluster role grants.
//
// A user who already reaches a cluster asks for a higher role on it for a
// bounded time with a reason; a user holding admin.users.update (the same
// permission a direct grant needs) approves or rejects — never their own
// request. An approval writes a temporary grant (user_cluster_roles.expires_at)
// and revokes the requester's tokens, so the next request signs them in again
// with the role; the sweeper (internal/accessrequests) reverts the grant when
// the time passes. Off unless ACCESS_REQUESTS_ENABLED.
//
//   GET    /api/v1/auth/access-requests/config
//   POST   /api/v1/auth/access-requests
//   GET    /api/v1/auth/access-requests                      (own)
//   DELETE /api/v1/auth/access-requests/{id}                 (own, pending)
//   GET    /api/v1/auth/admin/access-requests?status=
//   POST   /api/v1/auth/admin/access-requests/{id}/approve   { "note": "" }
//   POST   /api/v1/auth/admin/access-requests/{id}/reject    { "note": "" }

// Audit actions (docs/audit-log-plan.md §5-2).
const (
	auditAccessRequestCreate  = "access.request.create"
	auditAccessRequestCancel  = "access.request.cancel"
	auditAccessRequestApprove = "access.request.approve"
	auditAccessRequestReject  = "access.request.reject"
)

type accessRequestsConfigResponse struct {
	Enabled  bool     `json:"enabled"`
	MaxHours int      `json:"max_hours"`
	Roles    []string `json:"roles"`
}

// AccessRequestsConfig tells the UI whether to offer requests and within what bounds.
func (h *AuthHandler) AccessRequestsConfig(w http.ResponseWriter, r *http.Request) {
	cfg := h.cfg.AccessRequests
	roles := make([]string, 0, len(cfg.Roles))
	for _, role := range cfg.Roles {
		if role = strings.TrimSpace(role); role != "" {
			roles = append(roles, role)
		}
	}
	response.JSON(w, http.StatusOK, accessRequestsConfigResponse{Enabled: cfg.Enabled, MaxHours: cfg.MaxHours, Roles: roles})
}

// CreateAccessRequest files a request for the signed-in user.
func (h *AuthHandler) CreateAccessRequest(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok {
		response.Error(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	if !h.cfg.AccessRequests.Enabled {
		response.Error(w, http.StatusNotFound, "Access requests are disabled")
		return
	}
	var in accessRequestInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	in.Reason = strings.TrimSpace(in.Reason)
	if err := validateAccessRequestInput(in, h.cfg.AccessRequests); err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx := r.Context()

	// Escalation only: the user must already hold a role on the cluster.
	grant, err := h.repo.GetUserClusterGrant(ctx, payload.UserID, in.ClusterID)
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	if grant == nil {
		response.Error(w, http.StatusForbidden, "You have no access to this cluster to escalate; ask an admin for a grant first")
		return
	}
	if strings.EqualFold(grant.Role, in.Role) {
		response.Error(w, http.StatusBadRequest, "You already hold this role on the cluster")
		return
	}
	role, err := h.repo.GetRoleByName(ctx, in.Role)
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	if role == nil {
		response.Error(w, http.StatusBadRequest, "Unknown role: "+in.Role)
		return
	}
	ceiling, err := h.repo.GetRoleByName(ctx, accessRequestCeilingRole)
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	if ceiling == nil {
		response.InternalError(w, r, errors.New("access requests: ceiling role "+accessRequestCeilingRole+" missing"))
		return
	}
	if uncovered := uncoveredPermissions(role.Permissions, ceiling.Permissions); len(uncovered) > 0 {
		response.Error(w, http.StatusBadRequest, "Role "+role.Name+" exceeds the "+accessRequestCeilingRole+" ceiling: "+strings.Join(uncovered, ", "))
		return
	}
	pending, err := h.repo.HasPendingAccessRequest(ctx, payload.UserID, in.ClusterID)
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	if pending {
		response.Error(w, http.StatusConflict, "You already have a pending request on this cluster")
		return
	}

	id := uuid.New().String()
	createErr := h.repo.CreateAccessRequest(ctx, id, payload.UserID, in.ClusterID, role.ID, in.DurationMinutes, in.Reason)
	target := &repository.AccessRequest{ID: id, UserID: payload.UserID, UserEmail: payload.Email, ClusterID: in.ClusterID, Role: role.Name}
	h.auditAccessRequest(r, auditAccessRequestCreate, payload, target, map[string]any{
		"request_id": id, "role": role.Name, "current_role": grant.Role,
		"duration_minutes": in.DurationMinutes, "reason": in.Reason,
	}, createErr)
	if createErr != nil {
		if repository.IsForeignKeyViolation(createErr) {
			response.Error(w, http.StatusNotFound, "Unknown cluster: "+in.ClusterID)
			return
		}
		response.InternalError(w, r, createErr)
		return
	}
	created, err := h.repo.GetAccessRequest(ctx, id)
	if err != nil || created == nil {
		response.JSON(w, http.StatusCreated, map[string]string{"id": id, "status": repository.AccessRequestPending})
		return
	}
	response.JSON(w, http.StatusCreated, created)
}

// ListMyAccessRequests returns the signed-in user's requests, newest first.
func (h *AuthHandler) ListMyAccessRequests(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok {
		response.Error(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	items, err := h.repo.ListAccessRequests(r.Context(), repository.AccessRequestFilter{UserID: payload.UserID, Limit: 50})
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	response.JSON(w, http.StatusOK, items)
}

// CancelAccessRequest withdraws the signed-in user's own pending request.
func (h *AuthHandler) CancelAccessRequest(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok {
		response.Error(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	id := chi.URLParam(r, "id")
	req, err := h.repo.GetAccessRequest(r.Context(), id)
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	if req == nil || req.UserID != payload.UserID {
		response.Error(w, http.StatusNotFound, "Access request not found")
		return
	}
	cancelErr := h.repo.CancelAccessRequest(r.Context(), id, payload.UserID, time.Now())
	h.auditAccessRequest(r, auditAccessRequestCancel, payload, req, map[string]any{"request_id": id, "role": req.Role}, cancelErr)
	if errors.Is(cancelErr, repository.ErrAccessRequestNotPending) {
		response.Error(w, http.StatusConflict, "Access request is "+req.Status)
		return
	}
	if cancelErr != nil {
		response.InternalError(w, r, cancelErr)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// AdminListAccessRequests lists requests (optionally one status) for reviewers.
func (h *AuthHandler) AdminListAccessRequests(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireClusterRoleAdmin(w, r); !ok {
		return
	}
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	items, err := h.repo.ListAccessRequests(r.Context(), repository.AccessRequestFilter{Status: status, Limit: 200})
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	response.JSON(w, http.StatusOK, items)
}

type accessRequestDecision struct {
	Note string `json:"note"`
}

// AdminApproveAccessRequest grants the requested role for the requested time.
func (h *AuthHandler) AdminApproveAccessRequest(w http.ResponseWriter, r *http.Request) {
	h.decideAccessRequest(w, r, true)
}

// AdminRejectAccessRequest refuses a pending request.
func (h *AuthHandler) AdminRejectAccessRequest(w http.ResponseWriter, r *http.Request) {
	h.decideAccessRequest(w, r, false)
}

func (h *AuthHandler) decideAccessRequest(w http.ResponseWriter, r *http.Request, approve bool) {
	payload, ok := h.requireClusterRoleAdmin(w, r)
	if !ok {
		return
	}
	action := auditAccessRequestReject
	if approve {
		action = auditAccessRequestApprove
	}
	ctx := r.Context()
	id := chi.URLParam(r, "id")
	req, err := h.repo.GetAccessRequest(ctx, id)
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	if req == nil {
		response.Error(w, http.StatusNotFound, "Access request not found")
		return
	}
	var in accessRequestDecision
	if r.Body != nil && r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			response.Error(w, http.StatusBadRequest, "Invalid request body")
			return
		}
	}
	in.Note = strings.TrimSpace(in.Note)
	if len(in.Note) > accessRequestReasonMax {
		response.Error(w, http.StatusBadRequest, "note too long")
		return
	}
	if req.Status != repository.AccessRequestPending {
		response.Error(w, http.StatusConflict, "Access request is "+req.Status)
		return
	}
	if err := canDecideAccessRequest(payload, req); err != nil {
		h.auditAccessRequest(r, action, payload, req, map[string]any{"request_id": id, "role": req.Role}, err)
		response.Error(w, http.StatusForbidden, err.Error())
		return
	}

	after := map[string]any{
		"request_id": id, "role": req.Role, "duration_minutes": req.DurationMinutes, "reason": req.Reason,
	}
	if in.Note != "" {
		after["note"] = in.Note
	}
	now := time.Now()
	if !approve {
		rejectErr := h.repo.RejectAccessRequest(ctx, id, payload.UserID, in.Note, now)
		h.auditAccessRequest(r, action, payload, req, after, rejectErr)
		if errors.Is(rejectErr, repository.ErrAccessRequestNotPending) {
			response.Error(w, http.StatusConflict, "Access request is no longer pending")
			return
		}
		if rejectErr != nil {
			response.InternalError(w, r, rejectErr)
			return
		}
		h.respondAccessRequest(w, r, id)
		return
	}

	// Ceiling, as for a direct grant: the approver must hold everything the
	// role gives on this cluster.
	perms, err := h.repo.GetPermissionsByRoleID(ctx, req.RoleID)
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	if missing := missingPermissions(payload, perms, req.ClusterID); len(missing) > 0 {
		err := ceilingError(missing)
		h.auditAccessRequest(r, action, payload, req, after, err)
		response.Error(w, http.StatusForbidden, err.Error())
		return
	}
	expiresAt, approveErr := h.repo.ApproveAccessRequest(ctx, id, payload.UserID, in.Note, now)
	if approveErr == nil {
		after["expires_at"] = expiresAt.UTC().Format(time.RFC3339)
	}
	h.auditAccessRequest(r, action, payload, req, after, approveErr)
	if errors.Is(approveErr, repository.ErrAccessRequestNotPending) {
		response.Error(w, http.StatusConflict, "Access request is no longer pending")
		return
	}
	if approveErr != nil {
		response.InternalError(w, r, approveErr)
		return
	}
	h.respondAccessRequest(w, r, id)
}

func (h *AuthHandler) respondAccessRequest(w http.ResponseWriter, r *http.Request, id string) {
	req, err := h.repo.GetAccessRequest(r.Context(), id)
	if err != nil || req == nil {
		response.JSON(w, http.StatusOK, map[string]string{"id": id})
		return
	}
	response.JSON(w, http.StatusOK, req)
}

// auditAccessRequest writes one row scoped to the request's cluster, the
// requester as target. Best-effort: a failed write never blocks the response.
func (h *AuthHandler) auditAccessRequest(r *http.Request, action string, actor auth.TokenPayload, req *repository.AccessRequest, after map[string]any, opErr error) {
	rec := audit.FromHTTPRequest(r)
	rec.Service = audit.ServiceAuth
	rec.Action = action
	rec.TargetType = "user"
	rec.TargetID = req.UserID
	rec.TargetEmail = req.UserEmail
	rec.Cluster = req.ClusterID
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
		slog.Error("failed to create audit log", "error", err, "action", action)
	}
}
