package handler

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/helm"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// --- Helm read endpoints (v1.0) ---
//
// All handlers sit behind resource.helm.read. The menu gate
// (menu.helm) is enforced in the frontend — the API checks the action
// permission so a direct API call still honours RBAC.
//
// Write endpoints (rollback / upgrade / uninstall / test) live in
// helm_write.go and will land as part of v1.1.

// GetHelmReleases handles GET /api/v1/helm/releases.
func (h *Handler) GetHelmReleases(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.helm.read"); err != nil {
		h.handleError(w, err)
		return
	}
	namespace := queryParam(r, "namespace", "")
	status := queryParam(r, "status", "")
	items, err := h.helmSvc.ListReleases(r.Context(), namespace, status)
	if err != nil {
		h.handleHelmError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"items": items})
}

// GetHelmRelease handles GET /api/v1/helm/releases/{namespace}/{name}.
func (h *Handler) GetHelmRelease(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.helm.read"); err != nil {
		h.handleError(w, err)
		return
	}
	ns := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	rel, err := h.helmSvc.GetRelease(r.Context(), ns, name)
	if err != nil {
		h.handleHelmError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, rel)
}

// GetHelmReleaseSection handles GET /api/v1/helm/releases/{namespace}/{name}/{section}.
// Returns one of manifest|values|notes|hooks as a YAML / plain string.
func (h *Handler) GetHelmReleaseSection(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.helm.read"); err != nil {
		h.handleError(w, err)
		return
	}
	ns := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	section := helm.SectionKind(chi.URLParam(r, "section"))
	text, err := h.helmSvc.GetSection(r.Context(), ns, name, section)
	if err != nil {
		h.handleHelmError(w, err)
		return
	}
	// Keep the wire type uniform with existing .../yaml endpoints.
	response.JSON(w, http.StatusOK, map[string]string{
		"section": string(section),
		"content": text,
	})
}

// GetHelmReleaseHistory handles GET /api/v1/helm/releases/{namespace}/{name}/history.
func (h *Handler) GetHelmReleaseHistory(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.helm.read"); err != nil {
		h.handleError(w, err)
		return
	}
	ns := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	items, err := h.helmSvc.GetHistory(r.Context(), ns, name)
	if err != nil {
		h.handleHelmError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"items": items})
}

// GetHelmRevisionSection handles GET /api/v1/helm/releases/{namespace}/{name}/revisions/{revision}/{section}.
func (h *Handler) GetHelmRevisionSection(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.helm.read"); err != nil {
		h.handleError(w, err)
		return
	}
	ns := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	rev := queryParamInt(r, "_ignored", 0) // satisfied by URL path param below
	revStr := chi.URLParam(r, "revision")
	rev = parsePositiveInt(revStr, 0)
	if rev <= 0 {
		response.Error(w, http.StatusBadRequest, "invalid revision")
		return
	}
	section := helm.SectionKind(chi.URLParam(r, "section"))
	// Full detail rather than the section-only path gives the UI a few
	// extra metadata fields (status/description) "for free" when the
	// user opens a revision row — avoids a second round-trip for the
	// overview banner in the history detail view.
	if section == "" {
		detail, err := h.helmSvc.GetRevision(r.Context(), ns, name, rev)
		if err != nil {
			h.handleHelmError(w, err)
			return
		}
		response.JSON(w, http.StatusOK, detail)
		return
	}
	text, err := h.helmSvc.GetRevisionSection(r.Context(), ns, name, rev, section)
	if err != nil {
		h.handleHelmError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{
		"revision": rev,
		"section":  string(section),
		"content":  text,
	})
}

// DiffHelmRelease handles POST /api/v1/helm/releases/{namespace}/{name}/diff.
func (h *Handler) DiffHelmRelease(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.helm.read"); err != nil {
		h.handleError(w, err)
		return
	}
	ns := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")

	var req helm.DiffRequest
	if err := decodeJSON(r, &req); err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Section == "" {
		req.Section = helm.SectionManifest
	}

	result, err := h.helmSvc.DiffRevisions(r.Context(), ns, name, req)
	if err != nil {
		h.handleHelmError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, result)
}

// GetHelmReleaseResources handles GET /api/v1/helm/releases/{namespace}/{name}/resources.
func (h *Handler) GetHelmReleaseResources(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.helm.read"); err != nil {
		h.handleError(w, err)
		return
	}
	ns := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	items, err := h.helmSvc.GetResources(r.Context(), ns, name)
	if err != nil {
		h.handleHelmError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"items": items})
}

// GetHelmReleaseImages handles GET /api/v1/helm/releases/{namespace}/{name}/images.
func (h *Handler) GetHelmReleaseImages(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.helm.read"); err != nil {
		h.handleError(w, err)
		return
	}
	ns := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	items, err := h.helmSvc.GetImages(r.Context(), ns, name)
	if err != nil {
		h.handleHelmError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"items": items})
}

// --- shared plumbing ---

// handleHelmError maps helm-specific sentinels to HTTP status codes
// before falling back to the generic handleError.
func (h *Handler) handleHelmError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, helm.ErrNotFound):
		response.Error(w, http.StatusNotFound, err.Error())
	case errors.Is(err, helm.ErrInvalidSection):
		response.Error(w, http.StatusBadRequest, err.Error())
	default:
		h.handleError(w, err)
	}
}

// parsePositiveInt parses a base-10 integer, returning fallback on any
// error or for non-positive values. Exists to avoid scattering the
// "revision must be > 0" check across handlers.
func parsePositiveInt(s string, fallback int) int {
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return fallback
		}
		n = n*10 + int(r-'0')
		if n < 0 {
			return fallback
		}
	}
	if n <= 0 {
		return fallback
	}
	return n
}
