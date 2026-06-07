package handler

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// kindFromPath derives the workload kind from the URL path.
func kindFromPath(path string) string {
	if strings.Contains(path, "/deployments/") {
		return "Deployment"
	}
	if strings.Contains(path, "/daemonsets/") {
		return "DaemonSet"
	}
	if strings.Contains(path, "/statefulsets/") {
		return "StatefulSet"
	}
	return ""
}

// GetWorkloadRevisions handles GET /api/v1/namespaces/{namespace}/{kind}/{name}/revisions.
func (h *Handler) GetWorkloadRevisions(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	kind := kindFromPath(r.URL.Path)
	if kind == "" {
		response.Error(w, http.StatusBadRequest, "unable to determine workload kind from URL")
		return
	}
	data, err := h.svc.GetRevisionHistory(ctx, namespace, name, kind)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// RollbackWorkload handles POST /api/v1/namespaces/{namespace}/{kind}/{name}/rollback.
func (h *Handler) RollbackWorkload(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermissionForCluster(r, "resource.workload.rollback"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	kind := kindFromPath(r.URL.Path)
	if kind == "" {
		response.Error(w, http.StatusBadRequest, "unable to determine workload kind from URL")
		return
	}

	var body struct {
		Revision int64 `json:"revision"`
	}
	if err := decodeJSON(r, &body); err != nil {
		h.handleError(w, err)
		return
	}
	if body.Revision <= 0 {
		response.Error(w, http.StatusBadRequest, "revision must be a positive integer")
		return
	}

	err := h.svc.RollbackWorkload(ctx, namespace, name, kind, body.Revision)
	action := "k8s." + strings.ToLower(kind) + ".rollback"
	h.recordAuditWithPayload(r, action, strings.ToLower(kind), name, namespace, err,
		nil, audit.MustJSON(map[string]interface{}{"revision": body.Revision}))
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{
		"rolled_back": true,
		"revision":    body.Revision,
	})
}
