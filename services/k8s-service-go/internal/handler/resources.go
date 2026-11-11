package handler

import (
	"fmt"
	"net/http"
	"strings"

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

	// If output=json, return full K8s objects (for Advanced Search), written as the pages come
	if output == "json" {
		h.streamRawList(w, r, resourceType, namespace, labelSelector)
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
		canReveal := h.canForCluster(r, "resource.secret.reveal")
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

// applyYAMLBody is the body of a YAML apply, read the same way by the namespace scope check.
type applyYAMLBody struct {
	ResourceType string `json:"resource_type"`
	Namespace    string `json:"namespace"`
	Name         string `json:"name"`
	ResourceName string `json:"resource_name"`
	YAML         string `json:"yaml"`
	// where a YAML window's edit began: a save takes out of the object what left this text (k8s.ApplyEditedYAML)
	Opened *yamlOpened `json:"opened"`
}

// yamlOpened is the text an edit began from, as what it does not share with the text saved: the two whole would pass the
// 1 MiB body limit at half the size of the largest object that saves today.
type yamlOpened struct {
	Head  int      `json:"head"`
	Tail  int      `json:"tail"`
	Lines []string `json:"lines"`
}

// text is the text an edit began from, given the text saved; "" for none, or for an answer that does not fit that text.
func (o *yamlOpened) text(saved string) string {
	if o == nil {
		return ""
	}
	lines := strings.Split(saved, "\n")
	if o.Head < 0 || o.Tail < 0 || o.Head+o.Tail > len(lines) {
		return ""
	}
	out := make([]string, 0, o.Head+len(o.Lines)+o.Tail)
	out = append(out, lines[:o.Head]...)
	out = append(out, o.Lines...)
	out = append(out, lines[len(lines)-o.Tail:]...)
	return strings.Join(out, "\n")
}

// ApplyResourceYAML handles POST /api/v1/resources/yaml/apply. It needs the
// edit permission of the kind the resource type resolves to.
func (h *Handler) ApplyResourceYAML(w http.ResponseWriter, r *http.Request) {
	var body applyYAMLBody
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
	if h.cfg.AdmissionPoliciesReadOnly && admissionPolicyKind(kind) {
		h.recordAuditWithPayload(r, "k8s.yaml.apply", body.ResourceType, body.Name, body.Namespace, errAdmissionPoliciesReadOnly, nil, nil)
		response.Error(w, http.StatusForbidden, errAdmissionPoliciesReadOnly.Error())
		return
	}

	var data map[string]interface{}
	var keptMasked []string
	if !h.canForCluster(r, "resource.secret.reveal") && h.isSecretResourceType(r, body.ResourceType) {
		data, keptMasked, err = h.svc.ApplySecretYAMLWithoutReveal(ctx, body.ResourceType, body.Namespace, body.Name, body.Opened.text(body.YAML), body.YAML)
	} else {
		data, err = h.svc.ApplyEditedYAML(ctx, body.ResourceType, body.Namespace, body.Name, body.Opened.text(body.YAML), body.YAML)
	}
	after := map[string]interface{}{
		"resource_type": body.ResourceType,
		"yaml_len":      len(body.YAML),
	}
	if len(keptMasked) > 0 {
		after["kept_masked"] = keptMasked
	}
	h.recordAuditWithPayload(r, "k8s.yaml.apply", body.ResourceType, body.Name, body.Namespace, err, nil, audit.MustJSON(after))
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// createYAMLBody is the body of a YAML create, read the same way by the namespace scope check.
type createYAMLBody struct {
	YAML      string `json:"yaml"`
	Namespace string `json:"namespace"`
}

// yamlCreateObjectsMax bounds the objects one create's audit row lists; objects_total says how many there were.
const yamlCreateObjectsMax = 100

// CreateResourcesFromYAML handles POST /api/v1/resources/yaml/create. Every
// document needs the create permission of its kind.
func (h *Handler) CreateResourcesFromYAML(w http.ResponseWriter, r *http.Request) {
	var body createYAMLBody
	if err := decodeJSON(r, &body); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}
	if strings.TrimSpace(body.YAML) == "" {
		response.Error(w, http.StatusBadRequest, "yaml is required")
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
	for _, kind := range kinds {
		if h.cfg.AdmissionPoliciesReadOnly && admissionPolicyKind(kind) {
			h.recordAuditWithPayload(r, "k8s.yaml.create", "multi", "", "", errAdmissionPoliciesReadOnly, nil,
				audit.MustJSON(map[string]interface{}{"yaml_len": len(body.YAML), "default_namespace": body.Namespace}))
			response.Error(w, http.StatusForbidden, errAdmissionPoliciesReadOnly.Error())
			return
		}
	}
	if !h.canForCluster(r, "resource.secret.reveal") {
		if masks := k8s.YAMLSecretMasks(body.YAML); len(masks) > 0 {
			refused := fmt.Errorf("a new Secret has no value for %s to stand for (%s): write the value or leave it out", k8s.SecretMask, strings.Join(masks, ", "))
			h.recordAuditWithPayload(r, "k8s.yaml.create", "multi", "", "", refused, nil,
				audit.MustJSON(map[string]interface{}{"yaml_len": len(body.YAML), "default_namespace": body.Namespace}))
			response.Error(w, http.StatusBadRequest, refused.Error())
			return
		}
	}

	ctx := r.Context()
	// Named before the create so a failed one's row says what it was asked to make; the text itself stays out of the row.
	objects, total := h.svc.CreateObjects(ctx, body.YAML, body.Namespace, yamlCreateObjectsMax)
	data, err := h.svc.CreateResourcesFromYAML(ctx, body.YAML, body.Namespace)
	h.recordAuditWithPayload(r, "k8s.yaml.create", "multi", "", "", err,
		nil, audit.MustJSON(map[string]interface{}{
			"yaml_len":          len(body.YAML),
			"default_namespace": body.Namespace,
			"objects":           objects,
			"objects_total":     total,
			"objects_created":   len(data),
		}))
	if err != nil && len(data) > 0 {
		// the documents before the one it stopped at stay made: the refusal names them, so a partial create is not
		// read as nothing made (and pressing Create again as "already exists")
		status := statusForError(err)
		if failure, ok := w.(clusterFailureNoter); ok && status == http.StatusServiceUnavailable {
			failure.noteClusterFailure()
		}
		response.JSON(w, status, map[string]interface{}{"detail": response.Public(err), "created": data})
		return
	}
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
		canReveal := h.canForCluster(r, "resource.secret.reveal")
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
