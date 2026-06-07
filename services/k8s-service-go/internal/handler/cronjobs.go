package handler

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// GetAllCronJobs handles GET /api/v1/cronjobs/all.
func (h *Handler) GetAllCronJobs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllCronJobs(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetCronJobs handles GET /api/v1/namespaces/{namespace}/cronjobs.
func (h *Handler) GetCronJobs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetCronJobs(ctx, namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeCronJob handles GET /api/v1/namespaces/{namespace}/cronjobs/{name}/describe.
func (h *Handler) DescribeCronJob(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeCronJob(ctx, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetCronJobYAML handles GET /api/v1/namespaces/{namespace}/cronjobs/{name}/yaml.
func (h *Handler) GetCronJobYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	force := queryParamBool(r, "force_refresh", false)
	data, err := h.svc.GetGenericResourceYAML(ctx, "cronjobs", namespace, name, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// SuspendCronJob handles PATCH /api/v1/namespaces/{namespace}/cronjobs/{name}/suspend.
func (h *Handler) SuspendCronJob(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermissionForCluster(r, "resource.cronjob.suspend"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")

	var body struct {
		Suspend bool `json:"suspend"`
	}
	if err := decodeJSON(r, &body); err != nil {
		h.handleError(w, err)
		return
	}
	err := h.svc.SuspendCronJob(ctx, namespace, name, body.Suspend)
	action := "k8s.cronjob.suspend"
	if !body.Suspend {
		action = "k8s.cronjob.resume"
	}
	h.recordAuditWithPayload(r, action, "cronjob", name, namespace, err,
		nil, audit.MustJSON(map[string]interface{}{"suspend": body.Suspend}))
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"suspend": body.Suspend})
}

// TriggerCronJob handles POST /api/v1/namespaces/{namespace}/cronjobs/{name}/trigger.
func (h *Handler) TriggerCronJob(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermissionForCluster(r, "resource.cronjob.trigger"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	jobName, err := h.svc.TriggerCronJob(ctx, namespace, name)
	var after json.RawMessage
	if err == nil {
		after = audit.MustJSON(map[string]interface{}{"job_name": jobName})
	}
	h.recordAuditWithPayload(r, "k8s.cronjob.trigger", "cronjob", name, namespace, err, nil, after)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"job_name": jobName})
}

// GetCronJobOwnedJobs handles GET /api/v1/namespaces/{namespace}/cronjobs/{name}/jobs.
func (h *Handler) GetCronJobOwnedJobs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.GetCronJobOwnedJobs(ctx, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DeleteCronJob handles DELETE /api/v1/namespaces/{namespace}/cronjobs/{name}.
func (h *Handler) DeleteCronJob(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermissionForCluster(r, "resource.cronjob.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	err := h.svc.DeleteCronJob(ctx, namespace, name)
	h.recordAudit(r, "k8s.cronjob.delete", "cronjob", name, namespace, err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}
