package handler

import (
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/dormant"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// Dormant accounts: the config the console reads, the admin "sweep now" and
// the unlock that clears a dormant (or password) lock. The sweeper itself
// runs from main.go; the locks it sets are enforced in the password login,
// the OIDC callback and the API key exchange whether or not the feature is
// still on.

// SetDormantSweeper gives the handler the sweeper "sweep now" runs.
func (h *AuthHandler) SetDormantSweeper(s *dormant.Sweeper) { h.dormant = s }

type dormantAccountsConfigResponse struct {
	Enabled      bool `json:"enabled"`
	Days         int  `json:"days"`
	ExemptAdmins bool `json:"exempt_admins"`
}

// DormantAccountsConfig handles GET /auth/dormant-accounts/config.
func (h *AuthHandler) DormantAccountsConfig(w http.ResponseWriter, r *http.Request) {
	cfg := h.cfg.DormantAccounts
	response.JSON(w, http.StatusOK, dormantAccountsConfigResponse{Enabled: cfg.Enabled, Days: cfg.Days, ExemptAdmins: cfg.ExemptAdmins})
}

// errDormant is the reason a locked account's sign-in or key exchange is refused.
var errDormant = errors.New("account locked as dormant")

// AdminDormantSweep handles POST /auth/admin/dormant-accounts/sweep: one
// sweep now (admin.users.update), recorded as admin.dormant.sweep with the
// accounts it locked.
func (h *AuthHandler) AdminDormantSweep(w http.ResponseWriter, r *http.Request) {
	payload, ok := requirePerm(h.auditStore, w, r, "admin.users.update")
	if !ok {
		return
	}
	if !h.cfg.DormantAccounts.Enabled || h.dormant == nil {
		response.Error(w, http.StatusNotFound, "Dormant account locking is disabled")
		return
	}
	res := h.dormant.RunOnce(r.Context())
	emails := make([]string, 0, len(res.Locked))
	for _, d := range res.Locked {
		emails = append(emails, d.Email)
	}
	rec := audit.FromHTTPRequest(r)
	rec.Service = audit.ServiceAdmin
	rec.Action = "admin.dormant.sweep"
	rec.ActorUserID = payload.UserID
	rec.ActorEmail = payload.Email
	rec.TargetType = "dormant-accounts"
	rec.After = audit.MustJSON(map[string]any{"cutoff": res.Cutoff.Format(time.RFC3339), "days": h.cfg.DormantAccounts.Days, "locked": len(res.Locked), "users": emails})
	if res.Err != nil {
		rec.Result = audit.ResultFailure
		rec.Error = res.Err.Error()
	}
	_, _ = h.auditStore.Write(r.Context(), rec)
	if res.Err != nil {
		response.InternalError(w, r, res.Err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]any{"cutoff": res.Cutoff, "locked": len(res.Locked), "users": emails})
}

// AdminUnlockUser handles POST /auth/admin/users/{user_id}/unlock: clears the
// dormant lock and the password lock (admin.users.update), recorded as
// admin.users.unlock.
func (h *AuthHandler) AdminUnlockUser(w http.ResponseWriter, r *http.Request) {
	payload, ok := requirePerm(h.auditStore, w, r, "admin.users.update")
	if !ok {
		return
	}
	userID := chi.URLParam(r, "user_id")
	user, err := h.repo.GetUserByID(r.Context(), userID)
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	if user == nil {
		response.Error(w, http.StatusNotFound, "User not found")
		return
	}
	before := audit.MustJSON(map[string]any{"dormant_locked_at": user.DormantLockedAt, "locked_until": user.LockedUntil})
	found, err := h.repo.UnlockUser(r.Context(), userID)
	rec := audit.FromHTTPRequest(r)
	rec.Service = audit.ServiceAdmin
	rec.Action = "admin.users.unlock"
	rec.ActorUserID = payload.UserID
	rec.ActorEmail = payload.Email
	rec.TargetType = "user"
	rec.TargetID = user.ID
	rec.TargetEmail = user.Email
	rec.Before = before
	if err != nil {
		rec.Result = audit.ResultFailure
		rec.Error = err.Error()
		_, _ = h.auditStore.Write(r.Context(), rec)
		response.InternalError(w, r, err)
		return
	}
	if !found {
		response.Error(w, http.StatusNotFound, "User not found")
		return
	}
	_, _ = h.auditStore.Write(r.Context(), rec)
	user.DormantLockedAt, user.LockedUntil = nil, nil
	response.JSON(w, http.StatusOK, user.ToResponse())
}
