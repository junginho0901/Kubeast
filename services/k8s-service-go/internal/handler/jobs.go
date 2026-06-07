package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// GetAllJobs handles GET /api/v1/jobs/all.
func (h *Handler) GetAllJobs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllJobs(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetJobs handles GET /api/v1/namespaces/{namespace}/jobs.
func (h *Handler) GetJobs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetJobs(ctx, namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeJob handles GET /api/v1/namespaces/{namespace}/jobs/{name}/describe.
func (h *Handler) DescribeJob(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeJob(ctx, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetJobYAML handles GET /api/v1/namespaces/{namespace}/jobs/{name}/yaml.
func (h *Handler) GetJobYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	force := queryParamBool(r, "force_refresh", false)
	data, err := h.svc.GetGenericResourceYAML(ctx, "jobs", namespace, name, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// DeleteJob handles DELETE /api/v1/namespaces/{namespace}/jobs/{name}.
func (h *Handler) DeleteJob(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermissionForCluster(r, "resource.job.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	err := h.svc.DeleteJob(ctx, namespace, name)
	h.recordAudit(r, "k8s.job.delete", "job", name, namespace, err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}
