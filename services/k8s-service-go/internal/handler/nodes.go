package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kube-assistant/services/pkg/response"
)

// GetNodes handles GET /api/v1/nodes.
func (h *Handler) GetNodes(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetNodes(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeNode handles GET /api/v1/nodes/{name}/describe.
func (h *Handler) DescribeNode(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeNode(ctx, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetNodeYAML handles GET /api/v1/nodes/{name}/yaml.
func (h *Handler) GetNodeYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	force := queryParamBool(r, "force_refresh", false)
	data, err := h.svc.GetNodeYAML(ctx, name, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// GetNodePods handles GET /api/v1/nodes/{name}/pods.
func (h *Handler) GetNodePods(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	data, err := h.svc.GetNodePods(ctx, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetNodeEvents handles GET /api/v1/nodes/{name}/events.
func (h *Handler) GetNodeEvents(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	data, err := h.svc.GetNodeEvents(ctx, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DeleteNode handles DELETE /api/v1/nodes/{name}.
func (h *Handler) DeleteNode(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.node.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	if err := h.svc.DeleteNode(ctx, name); err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}

// ApplyNodeYAML handles POST /api/v1/nodes/{name}/yaml/apply.
func (h *Handler) ApplyNodeYAML(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.node.edit"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	name := chi.URLParam(r, "name")

	var body struct {
		YAML string `json:"yaml"`
	}
	if err := decodeJSON(r, &body); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	data, err := h.svc.ApplyResourceYAML(ctx, "nodes", "", name, body.YAML)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// CordonNode handles POST /api/v1/nodes/{name}/cordon.
func (h *Handler) CordonNode(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.node.cordon"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	if err := h.svc.CordonNode(ctx, name); err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"status": "cordoned", "unschedulable": true})
}

// UncordonNode handles POST /api/v1/nodes/{name}/uncordon.
func (h *Handler) UncordonNode(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.node.cordon"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	if err := h.svc.UncordonNode(ctx, name); err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"status": "uncordoned", "unschedulable": false})
}
