package handler

import (
	"net/http"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// GetGenericResources handles GET /api/v1/resources.
func (h *Handler) GetGenericResources(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	resourceType := queryParam(r, "resource_type", "")
	namespace := queryParam(r, "namespace", "")
	labelSelector := queryParam(r, "label_selector", "")
	output := queryParam(r, "output", "")
	allNamespaces := queryParamBool(r, "all_namespaces", false)

	if resourceType == "" {
		response.Error(w, http.StatusBadRequest, "resource_type is required")
		return
	}

	// If all_namespaces is set, clear namespace
	if allNamespaces {
		namespace = ""
	}

	// If output=json, return full K8s objects (for Advanced Search)
	if output == "json" {
		data, err := h.svc.GetGenericResourcesRaw(ctx, resourceType, namespace, labelSelector)
		if err != nil {
			h.handleError(w, err)
			return
		}
		maskSecretList(data) // lists never carry Secret values
		response.JSON(w, http.StatusOK, data)
		return
	}

	data, err := h.svc.GetGenericResources(ctx, resourceType, namespace, labelSelector)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetGenericResourceJSON handles GET /api/v1/resources/json.
// Returns a single K8s resource as full unstructured JSON (same shape Advanced Search uses).
func (h *Handler) GetGenericResourceJSON(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	resourceType := queryParam(r, "resource_type", "")
	namespace := queryParam(r, "namespace", "")
	name := queryParam(r, "resource_name", "")
	if name == "" {
		name = queryParam(r, "name", "")
	}

	if resourceType == "" || name == "" {
		response.Error(w, http.StatusBadRequest, "resource_type and resource_name are required")
		return
	}

	data, err := h.svc.GetGenericResourceRaw(ctx, resourceType, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	// A Secret's values: the dedicated endpoints' rule (reveal permission,
	// audited) — otherwise masked.
	if isSecretObject(data) {
		reveal, rerr := h.secretRevealAllowed(r, namespace, name, "generic-json", nil)
		if rerr != nil {
			h.refuseUnaudited(w, r, rerr)
			return
		}
		if !reveal {
			maskSecretValues(data)
		}
	}
	response.JSON(w, http.StatusOK, data)
}

// GetGenericResourceYAML handles GET /api/v1/resources/yaml.
func (h *Handler) GetGenericResourceYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	resourceType := queryParam(r, "resource_type", "")
	namespace := queryParam(r, "namespace", "")
	name := queryParam(r, "resource_name", "")
	if name == "" {
		name = queryParam(r, "name", "")
	}
	force := queryParamBool(r, "force_refresh", false)

	if resourceType == "" || name == "" {
		response.Error(w, http.StatusBadRequest, "resource_type and resource_name are required")
		return
	}

	// Secrets take the dedicated path: values only with resource.secret.reveal
	// (audited), masked otherwise, and never through the YAML cache.
	if h.isSecretResourceType(r, resourceType) {
		canReveal := h.requirePermissionForCluster(r, "resource.secret.reveal") == nil
		if canReveal {
			if rerr := h.auditReady(r); rerr != nil {
				h.refuseUnaudited(w, r, rerr)
				return
			}
		}
		data, err := h.svc.GetSecretYAML(ctx, namespace, name, canReveal)
		if canReveal {
			if werr := h.recordAuditWithPayload(r, "k8s.secret.reveal", "secret", name, namespace, err,
				nil, audit.MustJSON(map[string]interface{}{"via": "generic-yaml"})); werr != nil {
				h.refuseUnaudited(w, r, werr)
				return
			}
		}
		if err != nil {
			h.handleError(w, err)
			return
		}
		response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
		return
	}

	data, err := h.svc.GetGenericResourceYAML(ctx, resourceType, namespace, name, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// ApplyResourceYAML handles POST /api/v1/resources/yaml/apply. It needs the
// edit permission of the kind the resource type resolves to.
func (h *Handler) ApplyResourceYAML(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ResourceType string `json:"resource_type"`
		Namespace    string `json:"namespace"`
		Name         string `json:"name"`
		ResourceName string `json:"resource_name"`
		YAML         string `json:"yaml"`
	}
	if err := decodeJSON(r, &body); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}
	if body.Name == "" {
		body.Name = body.ResourceName
	}

	ctx := r.Context()
	kind, err := h.svc.ResourceKind(ctx, body.ResourceType)
	if err != nil {
		h.handleError(w, err)
		return
	}
	if err := h.requirePermissionForCluster(r, "resource."+permResource(kind)+".edit"); err != nil {
		h.handleError(w, err)
		return
	}

	data, err := h.svc.ApplyResourceYAML(ctx, body.ResourceType, body.Namespace, body.Name, body.YAML)
	h.recordAuditWithPayload(r, "k8s.yaml.apply", body.ResourceType, body.Name, body.Namespace, err,
		nil, audit.MustJSON(map[string]interface{}{
			"resource_type": body.ResourceType,
			"yaml_len":      len(body.YAML),
		}))
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// CreateResourcesFromYAML handles POST /api/v1/resources/yaml/create. Every
// document needs the create permission of its kind.
func (h *Handler) CreateResourcesFromYAML(w http.ResponseWriter, r *http.Request) {
	var body struct {
		YAML      string `json:"yaml"`
		Namespace string `json:"namespace"`
	}
	if err := decodeJSON(r, &body); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}
	// A decode error is the service's to report; the documents before it are the ones it creates.
	kinds, _ := k8s.YAMLKinds(body.YAML)
	for _, kind := range kinds {
		if err := h.requirePermissionForCluster(r, "resource."+permResource(kind)+".create"); err != nil {
			h.handleError(w, err)
			return
		}
	}

	ctx := r.Context()
	data, err := h.svc.CreateResourcesFromYAML(ctx, body.YAML, body.Namespace)
	h.recordAuditWithPayload(r, "k8s.yaml.create", "multi", "", "", err,
		nil, audit.MustJSON(map[string]interface{}{
			"yaml_len":          len(body.YAML),
			"default_namespace": body.Namespace,
		}))
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeGenericResource handles GET /api/v1/resources/describe.
func (h *Handler) DescribeGenericResource(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	resourceType := queryParam(r, "resource_type", "")
	namespace := queryParam(r, "namespace", "")
	name := queryParam(r, "resource_name", "")
	if name == "" {
		name = queryParam(r, "name", "")
	}

	if resourceType == "" || name == "" {
		response.Error(w, http.StatusBadRequest, "resource_type and resource_name are required")
		return
	}

	// Secrets take the dedicated describe (values masked without reveal).
	if h.isSecretResourceType(r, resourceType) {
		canReveal := h.requirePermissionForCluster(r, "resource.secret.reveal") == nil
		if canReveal {
			if rerr := h.auditReady(r); rerr != nil {
				h.refuseUnaudited(w, r, rerr)
				return
			}
		}
		data, err := h.svc.DescribeSecret(ctx, namespace, name, canReveal)
		if canReveal {
			if werr := h.recordAuditWithPayload(r, "k8s.secret.reveal", "secret", name, namespace, err,
				nil, audit.MustJSON(map[string]interface{}{"via": "generic-describe"})); werr != nil {
				h.refuseUnaudited(w, r, werr)
				return
			}
		}
		if err != nil {
			h.handleError(w, err)
			return
		}
		response.JSON(w, http.StatusOK, data)
		return
	}

	data, err := h.svc.DescribeGenericResource(ctx, resourceType, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}
