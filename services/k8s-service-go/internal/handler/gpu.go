package handler

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kube-assistant/services/pkg/response"
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
	if err := h.requireWrite(r); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	if err := h.svc.DeleteDeviceClass(ctx, name); err != nil {
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
	if err := h.requireWrite(r); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	if err := h.svc.DeleteResourceClaim(ctx, namespace, name); err != nil {
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
	if err := h.requireWrite(r); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	if err := h.svc.DeleteResourceClaimTemplate(ctx, namespace, name); err != nil {
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
	if err := h.requireWrite(r); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	if err := h.svc.DeleteResourceSlice(ctx, name); err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}
