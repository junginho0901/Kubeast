package handler

import (
	"net/http"

	"github.com/junginho0901/kubeast/services/pkg/audit"
)

// Secret values on the generic resource paths (/resources, /resources/json,
// /resources/yaml, /resources/describe, /search) follow the dedicated Secret
// endpoints: data/stringData are shown only to a caller holding
// resource.secret.reveal, and that read is audited as k8s.secret.reveal.
// Lists and searches never carry values — no screen needs them there.

const secretMask = "***"

func isSecretObject(obj map[string]interface{}) bool {
	kind, _ := obj["kind"].(string)
	return kind == "Secret"
}

// maskSecretValues blanks data/stringData (and the last-applied annotation,
// which repeats them) of a Secret object in place. Other kinds are untouched.
func maskSecretValues(obj map[string]interface{}) bool {
	if obj == nil || !isSecretObject(obj) {
		return false
	}
	for _, key := range []string{"data", "stringData"} {
		if m, ok := obj[key].(map[string]interface{}); ok {
			for k := range m {
				m[k] = secretMask
			}
		}
	}
	if md, ok := obj["metadata"].(map[string]interface{}); ok {
		if ann, ok := md["annotations"].(map[string]interface{}); ok {
			if _, ok := ann["kubectl.kubernetes.io/last-applied-configuration"]; ok {
				ann["kubectl.kubernetes.io/last-applied-configuration"] = secretMask
			}
		}
	}
	return true
}

// maskSecretItems masks every Secret in a list payload; returns how many.
func maskSecretItems(items []map[string]interface{}) int {
	n := 0
	for _, it := range items {
		if maskSecretValues(it) {
			n++
		}
	}
	return n
}

// maskSecretList masks the items of a {"items": [...]} payload in place.
func maskSecretList(data map[string]interface{}) int {
	if data == nil {
		return 0
	}
	switch items := data["items"].(type) {
	case []map[string]interface{}:
		return maskSecretItems(items)
	case []interface{}:
		n := 0
		for _, it := range items {
			if m, ok := it.(map[string]interface{}); ok && maskSecretValues(m) {
				n++
			}
		}
		return n
	}
	return 0
}

// isSecretResourceType says whether resource_type names core/v1 Secrets
// (whatever spelling: secret, secrets, v1/secrets ...).
func (h *Handler) isSecretResourceType(r *http.Request, resourceType string) bool {
	gvr, _, err := h.svc.ResolveResource(r.Context(), resourceType)
	return err == nil && gvr.Group == "" && gvr.Resource == "secrets"
}

// secretRevealAllowed is the dedicated endpoints' rule: true (and audited)
// when the caller holds resource.secret.reveal on this cluster. A non-nil
// error means the caller may reveal but the read cannot be recorded — the
// handler answers 503 instead of the values (refuseUnaudited).
func (h *Handler) secretRevealAllowed(r *http.Request, namespace, name, via string, err error) (bool, error) {
	if h.requirePermissionForCluster(r, "resource.secret.reveal") != nil {
		return false, nil
	}
	if rerr := h.auditReady(r); rerr != nil {
		return false, rerr
	}
	if werr := h.recordAuditWithPayload(r, "k8s.secret.reveal", "secret", name, namespace, err,
		nil, audit.MustJSON(map[string]interface{}{"via": via})); werr != nil {
		return false, werr
	}
	return true, nil
}
