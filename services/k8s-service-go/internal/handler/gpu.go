package handler

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// isDRAAPINotAvailable checks if the error indicates DRA API is not installed.
func isDRAAPINotAvailable(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "could not find the requested resource") ||
		strings.Contains(msg, "not found") ||
		strings.Contains(msg, "DRA API not available")
}

// --- GPU Dashboard ---

func (h *Handler) GetGPUDashboard(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetGPUDashboard(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// --- GPU Metrics (Prometheus / DCGM) ---

func (h *Handler) GetGPUMetrics(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetGPUMetrics(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// --- Prometheus Status & Query ---

func (h *Handler) GetPrometheusStatus(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data := h.svc.PrometheusStatus(ctx)
	response.JSON(w, http.StatusOK, data)
}

func (h *Handler) PrometheusQuery(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	query := r.URL.Query().Get("query")
	if query == "" {
		response.JSON(w, http.StatusBadRequest, map[string]string{"detail": "query parameter required"})
		return
	}

	if !h.svc.PrometheusAvailable(ctx) {
		response.JSON(w, http.StatusOK, map[string]interface{}{
			"available": false,
			"results":   []interface{}{},
		})
		return
	}

	results, err := h.svc.PrometheusQuery(ctx, query)
	if err != nil {
		h.handleError(w, err)
		return
	}

	// Convert to serializable format
	items := make([]map[string]interface{}, 0, len(results))
	for _, r := range results {
		items = append(items, map[string]interface{}{
			"metric": r.Metric,
			"value":  r.Value,
		})
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"available": true,
		"results":   items,
	})
}

// PrometheusQueryRange backs GET /api/v1/prometheus/query_range. Same response
// shape as the instant variant but each result has `points: [{t, v}]` instead
// of a single `value`. Used by feature detail modals (HPA scaling history,
// Node 24h CPU/Mem trend) — see refactor-plan.md.
func (h *Handler) PrometheusQueryRange(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := r.URL.Query().Get("query")
	if q == "" {
		response.JSON(w, http.StatusBadRequest, map[string]string{"detail": "query parameter required"})
		return
	}

	// Defaults: 24h window, 5m step.
	end := time.Now()
	start := end.Add(-24 * time.Hour)
	stepSec := 300

	if v := r.URL.Query().Get("start"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			start = time.Unix(n, 0)
		}
	}
	if v := r.URL.Query().Get("end"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			end = time.Unix(n, 0)
		}
	}
	if v := r.URL.Query().Get("step"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			stepSec = n
		}
	}

	if !h.svc.PrometheusAvailable(ctx) {
		response.JSON(w, http.StatusOK, map[string]interface{}{
			"available": false,
			"results":   []interface{}{},
		})
		return
	}

	results, err := h.svc.PrometheusQueryRange(ctx, q, start, end, stepSec)
	if err != nil {
		h.handleError(w, err)
		return
	}

	items := make([]map[string]interface{}, 0, len(results))
	for _, r := range results {
		pts := make([]map[string]float64, 0, len(r.Points))
		for _, p := range r.Points {
			pts = append(pts, map[string]float64{"t": p.T, "v": p.V})
		}
		items = append(items, map[string]interface{}{
			"metric": r.Metric,
			"points": pts,
		})
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"available": true,
		"results":   items,
	})
}

// GetClusterFeatures backs GET /api/v1/cluster/features. Returns the set of
// optional integrations the operator has enabled. The frontend reads this
// once at boot and uses it to skip e.g. all Prometheus queries when the
// integration is disabled.
func (h *Handler) GetClusterFeatures(w http.ResponseWriter, r *http.Request) {
	response.JSON(w, http.StatusOK, map[string]interface{}{
		"prometheus": map[string]interface{}{
			"enabled": k8s.PrometheusFeatureEnabled(),
		},
	})
}

// --- DeviceClasses ---

func (h *Handler) GetDeviceClasses(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetDeviceClasses(ctx)
	if err != nil {
		if isDRAAPINotAvailable(err) {
			response.JSON(w, http.StatusOK, []interface{}{})
			return
		}
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

func (h *Handler) DescribeDeviceClass(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeDeviceClass(ctx, name)
	if err != nil {
		if isDRAAPINotAvailable(err) {
			response.JSON(w, http.StatusNotFound, map[string]string{"detail": "DRA API not available"})
			return
		}
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

func (h *Handler) DeleteDeviceClass(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermissionForCluster(r, "resource.deviceclass.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	err := h.svc.DeleteDeviceClass(ctx, name)
	h.recordAudit(r, "k8s.deviceclass.delete", "deviceclass", name, "", err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}

// --- ResourceClaims ---

func (h *Handler) GetAllResourceClaims(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllResourceClaims(ctx)
	if err != nil {
		if isDRAAPINotAvailable(err) {
			response.JSON(w, http.StatusOK, []interface{}{})
			return
		}
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

func (h *Handler) GetResourceClaims(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetResourceClaims(ctx, namespace)
	if err != nil {
		if isDRAAPINotAvailable(err) {
			response.JSON(w, http.StatusOK, []interface{}{})
			return
		}
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

func (h *Handler) DescribeResourceClaim(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeResourceClaim(ctx, namespace, name)
	if err != nil {
		if isDRAAPINotAvailable(err) {
			response.JSON(w, http.StatusNotFound, map[string]string{"detail": "DRA API not available"})
			return
		}
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

func (h *Handler) DeleteResourceClaim(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermissionForCluster(r, "resource.resourceclaim.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	err := h.svc.DeleteResourceClaim(ctx, namespace, name)
	h.recordAudit(r, "k8s.resourceclaim.delete", "resourceclaim", name, namespace, err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}

// --- ResourceClaimTemplates ---

func (h *Handler) GetAllResourceClaimTemplates(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllResourceClaimTemplates(ctx)
	if err != nil {
		if isDRAAPINotAvailable(err) {
			response.JSON(w, http.StatusOK, []interface{}{})
			return
		}
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

func (h *Handler) GetResourceClaimTemplates(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetResourceClaimTemplates(ctx, namespace)
	if err != nil {
		if isDRAAPINotAvailable(err) {
			response.JSON(w, http.StatusOK, []interface{}{})
			return
		}
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

func (h *Handler) DescribeResourceClaimTemplate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeResourceClaimTemplate(ctx, namespace, name)
	if err != nil {
		if isDRAAPINotAvailable(err) {
			response.JSON(w, http.StatusNotFound, map[string]string{"detail": "DRA API not available"})
			return
		}
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

func (h *Handler) DeleteResourceClaimTemplate(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermissionForCluster(r, "resource.resourceclaimtemplate.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	err := h.svc.DeleteResourceClaimTemplate(ctx, namespace, name)
	h.recordAudit(r, "k8s.resourceclaimtemplate.delete", "resourceclaimtemplate", name, namespace, err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}

// --- ResourceSlices ---

func (h *Handler) GetResourceSlices(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetResourceSlices(ctx)
	if err != nil {
		if isDRAAPINotAvailable(err) {
			response.JSON(w, http.StatusOK, []interface{}{})
			return
		}
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

func (h *Handler) DescribeResourceSlice(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeResourceSlice(ctx, name)
	if err != nil {
		if isDRAAPINotAvailable(err) {
			response.JSON(w, http.StatusNotFound, map[string]string{"detail": "DRA API not available"})
			return
		}
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

func (h *Handler) DeleteResourceSlice(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermissionForCluster(r, "resource.resourceslice.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	err := h.svc.DeleteResourceSlice(ctx, name)
	h.recordAudit(r, "k8s.resourceslice.delete", "resourceslice", name, "", err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}
