package handler

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// --- Organization endpoints ---

// ListOrganizations handles GET /auth/organizations?type=hq|team (public, no admin required)
func (h *AuthHandler) ListOrganizations(w http.ResponseWriter, r *http.Request) {
	orgType := r.URL.Query().Get("type")
	if orgType != "hq" && orgType != "team" {
		response.Error(w, http.StatusBadRequest, "type must be hq or team")
		return
	}
	orgs, err := h.repo.ListOrganizations(r.Context(), orgType)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.JSON(w, http.StatusOK, orgs)
}

// AdminCreateOrganization handles POST /auth/admin/organizations
func (h *AuthHandler) AdminCreateOrganization(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok || !payload.HasPermission("admin.organizations.create") {
		response.Error(w, http.StatusForbidden, "Permission denied")
		return
	}

	var req struct {
		Type string `json:"type"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if req.Type != "hq" && req.Type != "team" {
		response.Error(w, http.StatusBadRequest, "type must be hq or team")
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		response.Error(w, http.StatusBadRequest, "name required")
		return
	}

	org, err := h.repo.CreateOrganization(r.Context(), req.Type, strings.TrimSpace(req.Name))
	if err != nil {
		if strings.Contains(err.Error(), "duplicate") || strings.Contains(err.Error(), "unique") {
			response.Error(w, http.StatusConflict, "Already exists")
			return
		}
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.JSON(w, http.StatusCreated, org)
}

// AdminDeleteOrganization handles DELETE /auth/admin/organizations/{id}
func (h *AuthHandler) AdminDeleteOrganization(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok || !payload.HasPermission("admin.organizations.delete") {
		response.Error(w, http.StatusForbidden, "Permission denied")
		return
	}

	idStr := chi.URLParam(r, "id")
	id, err := strconv.Atoi(idStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid ID")
		return
	}

	if err := h.repo.DeleteOrganization(r.Context(), id); err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
