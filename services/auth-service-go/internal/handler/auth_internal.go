package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/security"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// TokenVersion handles GET /auth/internal/token-version/{userID}: the current
// token_version of the bearer's own subject, for the other services'
// validators (services/pkg/auth token_version.go). The token is validated for
// signature, issuer, audience and expiry but not for its own "tv" — a revoked
// token must still be able to learn that it is revoked. The gateway never
// routes /api/v1/auth/internal/, so only in-cluster callers reach this.
func (h *AuthHandler) TokenVersion(w http.ResponseWriter, r *http.Request) {
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(strings.ToLower(header), "bearer ") {
		response.Error(w, http.StatusUnauthorized, "Bearer token required")
		return
	}
	claims, err := h.jwtMgr.ValidateToken(strings.TrimSpace(header[len("bearer "):]))
	if err != nil {
		response.Error(w, http.StatusUnauthorized, "Invalid token")
		return
	}
	sub := strings.TrimSpace(fmt.Sprintf("%v", claims["sub"]))
	userID := chi.URLParam(r, "userID")
	if sub == "" || sub == "<nil>" || sub != userID {
		response.Error(w, http.StatusForbidden, "Token does not belong to this user")
		return
	}
	// The investigator has no user row: its version is 0 while the feature is
	// on; off, the answer is "gone", so validators refuse a token already out.
	if sys, _ := claims["sys"].(string); sys != "" {
		if sys != auth.SystemInvestigator || sub != security.InvestigatorSubject || !h.cfg.AlertInvestigationEnabled {
			response.Error(w, http.StatusNotFound, "Unknown user")
			return
		}
		response.JSON(w, http.StatusOK, map[string]int{"tv": 0})
		return
	}
	tv, err := h.repo.GetTokenVersion(r.Context(), userID)
	if err != nil {
		response.Error(w, http.StatusNotFound, "Unknown user")
		return
	}
	response.JSON(w, http.StatusOK, map[string]int{"tv": tv})
}

// dns1123Label is a namespace name (RFC 1123 label).
var dns1123Label = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$`)

// investigatorTokenRequest is the body of POST /auth/internal/investigator-token.
type investigatorTokenRequest struct {
	ClusterID string `json:"cluster_id"`
	Namespace string `json:"namespace"`
}

// InvestigatorToken handles POST /auth/internal/investigator-token (behind the
// internal token; the gateway never routes /api/v1/auth/internal/): the alert
// investigator's short token for one cluster — read-only AI tools only, the
// namespace of the alert when it has one. 404 while
// features.alertInvestigation is off, 404 for a cluster Kubeast does not
// know. ai-service asks for one per investigation; the investigation itself
// is audited there (ai.investigation.run).
func (h *AuthHandler) InvestigatorToken(w http.ResponseWriter, r *http.Request) {
	if !h.cfg.AlertInvestigationEnabled {
		response.Error(w, http.StatusNotFound, "alert investigation is off (features.alertInvestigation.enabled)")
		return
	}
	var req investigatorTokenRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	req.ClusterID = strings.TrimSpace(req.ClusterID)
	req.Namespace = strings.TrimSpace(req.Namespace)
	if req.ClusterID == "" || req.ClusterID == "*" {
		response.Error(w, http.StatusBadRequest, "cluster_id is required")
		return
	}
	if req.Namespace != "" && !dns1123Label.MatchString(req.Namespace) {
		response.Error(w, http.StatusBadRequest, "namespace is not a valid name")
		return
	}
	ids, err := h.clusterIDs(r.Context())
	if err != nil {
		response.Error(w, http.StatusServiceUnavailable, "cluster registry unavailable")
		return
	}
	if !slices.Contains(ids, req.ClusterID) {
		response.Error(w, http.StatusNotFound, "unknown cluster")
		return
	}
	minutes := h.cfg.InvestigatorTokenMinutes
	if minutes <= 0 {
		minutes = 10
	}
	ttl := time.Duration(minutes) * time.Minute
	token, err := h.jwtMgr.CreateInvestigatorToken(req.ClusterID, req.Namespace, repository.ReadAIToolPermissions, ttl)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "token signing failed")
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"access_token": token, "expires_in": int(ttl.Seconds())})
}

// clusterIDs lists the registered clusters (a test replaces it).
func (h *AuthHandler) clusterIDs(ctx context.Context) ([]string, error) {
	if h.listClusterIDs != nil {
		return h.listClusterIDs(ctx)
	}
	return h.repo.ListClusterIDs(ctx)
}
