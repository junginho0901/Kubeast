package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// ClusterSwitch handles POST /api/v1/audit/cluster-switch.
//
// Any authenticated user may record a menu cluster switch; the frontend fires
// this and forgets. The write is best-effort — a Postgres failure still returns
// 204 so the UI switch is never blocked.
func (h *AuthHandler) ClusterSwitch(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok {
		response.Error(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	var req model.ClusterSwitchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if req.NewCluster == "" {
		response.Error(w, http.StatusBadRequest, "new_cluster required")
		return
	}

	rec := audit.FromHTTPRequest(r)
	rec.Service = audit.ServiceAuth
	rec.Action = "cluster.switch"
	rec.ActorUserID = payload.UserID
	rec.ActorEmail = payload.Email
	rec.TargetType = "cluster"
	rec.TargetID = req.NewCluster
	rec.Cluster = req.NewCluster
	rec.After = audit.MustJSON(map[string]string{
		"previous": req.PreviousCluster,
		"new":      req.NewCluster,
	})
	if _, err := h.auditStore.Write(r.Context(), rec); err != nil {
		slog.Error("cluster.switch audit write failed", "err", err)
	}

	w.WriteHeader(http.StatusNoContent)
}
