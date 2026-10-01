package handler

import (
	"net/http"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/redact"
)

// A Helm release carries its rendered manifest (Secret objects included) and
// the values it was installed with (chart passwords, tokens). Reading them in
// full is a Secret reveal: allowed with resource.secret.reveal and audited as
// helm.release.reveal; everyone else with resource.helm.read gets the text
// with Secret documents stripped and credential-looking values masked, the
// same rules the AI path applies (services/pkg/redact).

var helmRedactOpts = redact.Options{Enabled: true, Disabled: map[string]bool{}}

// helmReveal reports whether the caller may see the section in full and
// records the read when so.
func (h *Handler) helmReveal(r *http.Request, namespace, name, section string) bool {
	if h.requirePermissionForCluster(r, "resource.secret.reveal") != nil {
		return false
	}
	h.recordHelmAudit(r, "helm.release.reveal", "release", name, namespace, nil,
		nil, audit.MustJSON(map[string]interface{}{"section": section}))
	return true
}

func helmRedactText(s string) string {
	out, _ := redact.Text(s, helmRedactOpts)
	return out
}

func helmRedactValues(v map[string]interface{}) map[string]interface{} {
	if v == nil {
		return nil
	}
	out, _ := redact.Object(v, helmRedactOpts)
	if m, ok := out.(map[string]interface{}); ok {
		return m
	}
	return v
}
