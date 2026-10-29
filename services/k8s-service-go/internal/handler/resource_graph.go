package handler

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// GetResourceGraph handles GET /api/v1/resource-graph?namespaces=ns1,ns2
// If no namespaces query param, returns graph for all namespaces.
func (h *Handler) GetResourceGraph(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	var namespaces []string
	nsParam := r.URL.Query().Get("namespaces")
	if nsParam != "" {
		for _, ns := range strings.Split(nsParam, ",") {
			ns = strings.TrimSpace(ns)
			if ns != "" {
				namespaces = append(namespaces, ns)
			}
		}
	}

	data, err := h.svc.GetResourceGraph(ctx, namespaces, k8s.ResourceGraphOptions{})
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetNamespaceResourceGraph handles GET /api/v1/namespaces/{namespace}/resource-graph
// Backwards-compatible single-namespace endpoint.
func (h *Handler) GetNamespaceResourceGraph(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")

	data, err := h.svc.GetResourceGraph(ctx, []string{namespace}, k8s.ResourceGraphOptions{})
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}
