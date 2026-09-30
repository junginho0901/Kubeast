package handler

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

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
	tv, err := h.repo.GetTokenVersion(r.Context(), userID)
	if err != nil {
		response.Error(w, http.StatusNotFound, "Unknown user")
		return
	}
	response.JSON(w, http.StatusOK, map[string]int{"tv": tv})
}
