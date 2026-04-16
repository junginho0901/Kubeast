package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// --- Ingresses ---

// GetAllIngresses handles GET /api/v1/ingresses/all.
func (h *Handler) GetAllIngresses(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllIngresses(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetIngresses handles GET /api/v1/namespaces/{namespace}/ingresses.
func (h *Handler) GetIngresses(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetIngresses(ctx, namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeIngress handles GET /api/v1/namespaces/{namespace}/ingresses/{name}/describe.
func (h *Handler) DescribeIngress(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeIngress(ctx, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetIngressDetail handles GET /api/v1/namespaces/{namespace}/ingresses/{name}/detail.
// This is an alias for DescribeIngress to maintain compatibility with the frontend.
func (h *Handler) GetIngressDetail(w http.ResponseWriter, r *http.Request) {
	h.DescribeIngress(w, r)
}

// GetIngressYAML handles GET /api/v1/namespaces/{namespace}/ingresses/{name}/yaml.
func (h *Handler) GetIngressYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	force := queryParamBool(r, "force_refresh", false)
	data, err := h.svc.GetGenericResourceYAML(ctx, "ingresses", namespace, name, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// DeleteIngress handles DELETE /api/v1/namespaces/{namespace}/ingresses/{name}.
func (h *Handler) DeleteIngress(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.ingress.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	err := h.svc.DeleteIngress(ctx, namespace, name)
	h.recordAudit(r, "k8s.ingress.delete", "ingress", name, namespace, err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}

// --- IngressClasses ---

// GetIngressClasses handles GET /api/v1/ingressclasses.
func (h *Handler) GetIngressClasses(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetIngressClasses(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeIngressClass handles GET /api/v1/ingressclasses/{name}/describe.
func (h *Handler) DescribeIngressClass(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeIngressClass(ctx, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DeleteIngressClass handles DELETE /api/v1/ingressclasses/{name}.
func (h *Handler) DeleteIngressClass(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.ingressclass.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	err := h.svc.DeleteIngressClass(ctx, name)
	h.recordAudit(r, "k8s.ingressclass.delete", "ingressclass", name, "", err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}

// --- Endpoints ---

// GetAllEndpoints handles GET /api/v1/endpoints/all.
func (h *Handler) GetAllEndpoints(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllEndpoints(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetEndpoints handles GET /api/v1/namespaces/{namespace}/endpoints.
func (h *Handler) GetEndpoints(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetEndpoints(ctx, namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeEndpoints handles GET /api/v1/namespaces/{namespace}/endpoints/{name}/describe.
func (h *Handler) DescribeEndpoints(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeEndpoints(ctx, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetEndpointsYAML handles GET /api/v1/namespaces/{namespace}/endpoints/{name}/yaml.
func (h *Handler) GetEndpointsYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	force := queryParamBool(r, "force_refresh", false)
	data, err := h.svc.GetGenericResourceYAML(ctx, "endpoints", namespace, name, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// DeleteEndpoints handles DELETE /api/v1/namespaces/{namespace}/endpoints/{name}.
func (h *Handler) DeleteEndpoints(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.endpoints.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	err := h.svc.DeleteEndpoints(ctx, namespace, name)
	h.recordAudit(r, "k8s.endpoints.delete", "endpoints", name, namespace, err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}

// --- EndpointSlices ---

// GetAllEndpointSlices handles GET /api/v1/endpointslices/all.
func (h *Handler) GetAllEndpointSlices(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllEndpointSlices(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetEndpointSlices handles GET /api/v1/namespaces/{namespace}/endpointslices.
func (h *Handler) GetEndpointSlices(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetEndpointSlices(ctx, namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeEndpointSlice handles GET /api/v1/namespaces/{namespace}/endpointslices/{name}/describe.
func (h *Handler) DescribeEndpointSlice(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeEndpointSlice(ctx, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetEndpointSliceYAML handles GET /api/v1/namespaces/{namespace}/endpointslices/{name}/yaml.
func (h *Handler) GetEndpointSliceYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	force := queryParamBool(r, "force_refresh", false)
	data, err := h.svc.GetGenericResourceYAML(ctx, "endpointslices", namespace, name, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// DeleteEndpointSlice handles DELETE /api/v1/namespaces/{namespace}/endpointslices/{name}.
func (h *Handler) DeleteEndpointSlice(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.endpointslice.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	err := h.svc.DeleteEndpointSlice(ctx, namespace, name)
	h.recordAudit(r, "k8s.endpointslice.delete", "endpointslice", name, namespace, err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}

// --- NetworkPolicies ---

// GetAllNetworkPolicies handles GET /api/v1/networkpolicies/all.
func (h *Handler) GetAllNetworkPolicies(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllNetworkPolicies(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetNetworkPolicies handles GET /api/v1/namespaces/{namespace}/networkpolicies.
func (h *Handler) GetNetworkPolicies(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetNetworkPolicies(ctx, namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeNetworkPolicy handles GET /api/v1/namespaces/{namespace}/networkpolicies/{name}/describe.
func (h *Handler) DescribeNetworkPolicy(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeNetworkPolicy(ctx, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetNetworkPolicyYAML handles GET /api/v1/namespaces/{namespace}/networkpolicies/{name}/yaml.
func (h *Handler) GetNetworkPolicyYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	force := queryParamBool(r, "force_refresh", false)
	data, err := h.svc.GetGenericResourceYAML(ctx, "networkpolicies", namespace, name, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// DeleteNetworkPolicy handles DELETE /api/v1/namespaces/{namespace}/networkpolicies/{name}.
func (h *Handler) DeleteNetworkPolicy(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.networkpolicy.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	err := h.svc.DeleteNetworkPolicy(ctx, namespace, name)
	h.recordAudit(r, "k8s.networkpolicy.delete", "networkpolicy", name, namespace, err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}
