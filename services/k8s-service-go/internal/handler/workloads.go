package handler

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kube-assistant/services/pkg/response"
)

// --- StatefulSets ---

// GetAllStatefulSets handles GET /api/v1/statefulsets/all.
func (h *Handler) GetAllStatefulSets(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllStatefulSets(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetStatefulSets handles GET /api/v1/namespaces/{namespace}/statefulsets.
func (h *Handler) GetStatefulSets(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetStatefulSets(ctx, namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeStatefulSet handles GET /api/v1/namespaces/{namespace}/statefulsets/{name}/describe.
func (h *Handler) DescribeStatefulSet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeStatefulSet(ctx, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetStatefulSetYAML handles GET /api/v1/namespaces/{namespace}/statefulsets/{name}/yaml.
func (h *Handler) GetStatefulSetYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	force := queryParamBool(r, "force_refresh", false)
	data, err := h.svc.GetGenericResourceYAML(ctx, "statefulsets", namespace, name, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// DeleteStatefulSet handles DELETE /api/v1/namespaces/{namespace}/statefulsets/{name}.
func (h *Handler) DeleteStatefulSet(w http.ResponseWriter, r *http.Request) {
	if err := h.requireWrite(r); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	if err := h.svc.DeleteStatefulSet(ctx, namespace, name); err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}

// --- DaemonSets ---

// GetAllDaemonSets handles GET /api/v1/daemonsets/all.
func (h *Handler) GetAllDaemonSets(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllDaemonSets(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetDaemonSets handles GET /api/v1/namespaces/{namespace}/daemonsets.
func (h *Handler) GetDaemonSets(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetDaemonSets(ctx, namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeDaemonSet handles GET /api/v1/namespaces/{namespace}/daemonsets/{name}/describe.
func (h *Handler) DescribeDaemonSet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeDaemonSet(ctx, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetDaemonSetYAML handles GET /api/v1/namespaces/{namespace}/daemonsets/{name}/yaml.
func (h *Handler) GetDaemonSetYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	force := queryParamBool(r, "force_refresh", false)
	data, err := h.svc.GetGenericResourceYAML(ctx, "daemonsets", namespace, name, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// DeleteDaemonSet handles DELETE /api/v1/namespaces/{namespace}/daemonsets/{name}.
func (h *Handler) DeleteDaemonSet(w http.ResponseWriter, r *http.Request) {
	if err := h.requireWrite(r); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	if err := h.svc.DeleteDaemonSet(ctx, namespace, name); err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}

// --- ReplicaSets ---

// GetAllReplicaSets handles GET /api/v1/replicasets/all.
func (h *Handler) GetAllReplicaSets(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllReplicaSets(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetReplicaSets handles GET /api/v1/namespaces/{namespace}/replicasets.
func (h *Handler) GetReplicaSets(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetReplicaSets(ctx, namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeReplicaSet handles GET /api/v1/namespaces/{namespace}/replicasets/{name}/describe.
func (h *Handler) DescribeReplicaSet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeReplicaSet(ctx, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetReplicaSetYAML handles GET /api/v1/namespaces/{namespace}/replicasets/{name}/yaml.
func (h *Handler) GetReplicaSetYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	force := queryParamBool(r, "force_refresh", false)
	data, err := h.svc.GetGenericResourceYAML(ctx, "replicasets", namespace, name, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// DeleteReplicaSet handles DELETE /api/v1/namespaces/{namespace}/replicasets/{name}.
func (h *Handler) DeleteReplicaSet(w http.ResponseWriter, r *http.Request) {
	if err := h.requireWrite(r); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	if err := h.svc.DeleteReplicaSet(ctx, namespace, name); err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}

// --- Jobs ---

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
	if err := h.requireWrite(r); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	if err := h.svc.DeleteJob(ctx, namespace, name); err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}

// --- CronJobs ---

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
	if err := h.requireWrite(r); err != nil {
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
	if err := h.svc.SuspendCronJob(ctx, namespace, name, body.Suspend); err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"suspend": body.Suspend})
}

// TriggerCronJob handles POST /api/v1/namespaces/{namespace}/cronjobs/{name}/trigger.
func (h *Handler) TriggerCronJob(w http.ResponseWriter, r *http.Request) {
	if err := h.requireWrite(r); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	jobName, err := h.svc.TriggerCronJob(ctx, namespace, name)
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
	if err := h.requireWrite(r); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	if err := h.svc.DeleteCronJob(ctx, namespace, name); err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}

// --- Revision History & Rollback ---

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
	if err := h.requireAdmin(r); err != nil {
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

	if err := h.svc.RollbackWorkload(ctx, namespace, name, kind, body.Revision); err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{
		"rolled_back": true,
		"revision":    body.Revision,
	})
}
